/**
 * 管理员服务
 * 封装用户管理(角色/封禁)、系统配置管理以及游戏管理(公告/世界等级/GM指令)的数据访问逻辑。
 * 对应原版易语言：管理操作.ecode
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from '../game/player.service';
import { ChatService } from '../chat/chat.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { StaticDataService } from '../game/static-data.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  /** 服务器启动时间戳，用于计算 uptime */
  private readonly startTime: number = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly chatService: ChatService,
    private readonly systemConfigService: SystemConfigService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 分页查询用户列表
   */
  async listUsers(page = 1, pageSize = 20, keyword?: string) {
    const where = keyword
      ? {
          OR: [
            { username: { contains: keyword } },
            { nickname: { contains: keyword } },
            { qqNumber: { contains: keyword } },
          ],
        }
      : {};
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
          createdAt: true,
        },
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, list, page, pageSize };
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
    if (data.nickname !== undefined) updateData.nickname = data.nickname;
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

    // 初始背包（与新玩家一致）
    const initialBackpack = [
      { name: '石斧', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '皮帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '新手补给', type: '消耗品', quantity: 1, durability: 0, data: '' },
      { name: '面包', type: '消耗品', quantity: 3, durability: 0, data: '' },
    ];
    const initialWeapons = [{ name: '石斧', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' }];
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
    await this.prisma.player.update({
      where: { id: player.id },
      data: {
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
        markers: JSON.stringify({ '指引': 0 }),
        markers2: '[]',
        buffs: '[]',
        tasks: JSON.stringify(initialTasks),
        titles: JSON.stringify(['新人']),
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
      },
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

    // 在线玩家：取最近 5 分钟内有操作记录的玩家作为"在线"估算
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const onlinePlayers = await this.prisma.player.count({
      where: { updatedAt: { gte: fiveMinAgo } },
    });

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
   * 向世界频道写入一条系统消息，广播给所有在线玩家
   */
  async sendAnnouncement(content: string): Promise<void> {
    const channel = await this.chatService.ensureDefaultChannel();
    await this.chatService.saveMessage({
      channelId: channel.id,
      type: 'system',
      content: `【系统公告】${content}`,
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
   * @returns 操作结果文本
   */
  async gmGiveItem(userId: number, itemName: string, count: number): Promise<string> {
    const success = await this.playerService.addToBackpack(userId, itemName, count);
    if (!success) {
      throw new Error('物品发送失败，请检查用户ID和物品名称');
    }
    this.logger.log(`GM 给用户 ${userId} 发放了 ${count} 个 ${itemName}`);
    return `已向用户 ${userId} 发放 ${count} 个 ${itemName}`;
  }

  /**
   * GM 按目标标识发放物品（后台网页用）
   * @param target 用户名/昵称/QQ号/用户ID
   */
  async gmGiveItemToTarget(target: string | number, itemName: string, count: number): Promise<string> {
    const user = await this.resolveUserTarget(target);
    return this.gmGiveItem(user.id, itemName, count);
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

    await this.prisma.player.update({
      where: { id: player.id },
      data: { [field]: parsedValue },
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

    // 重置玩家数据到初始状态
    const initialBackpack = JSON.stringify([
      { name: '石斧', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '皮帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '新手补给', type: '消耗品', quantity: 1, durability: 0, data: '' },
      { name: '面包', type: '消耗品', quantity: 3, durability: 0, data: '' },
    ]);
    const initialMarkers = JSON.stringify({ '指引': 0 });
    const initialTitles = JSON.stringify(['新人']);

    await this.prisma.player.update({
      where: { id: player.id },
      data: {
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
        mapId: 1,
        location: '新手村',
        backpack: initialBackpack,
        equipment: '[]',
        weapons: '[]',
        markers: initialMarkers,
        titles: initialTitles,
        affinity: 0,
        vehicle: '',
      },
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
    await this.prisma.player.update({
      where: { id: player.id },
      data: { [field]: parsedValue },
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