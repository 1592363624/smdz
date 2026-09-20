/**
 * 世界红包服务：玩家挑背包道具发红包（发送时立即扣除）→ 其他玩家公屏点击领取，先到先得、
 * 每个红包每人限领 1 次 → 有效期（默认 24 小时，可配置）内没领完的份额自动退回发送者背包。
 * 背包读写统一走 PlayerService（内部 Actor 串行邮箱），本服务不直接改 Player JSON；
 * 领取份额用条件更新（claimedQuantity < quantity）抢占，杜绝并发超发；
 * 状态机：ACTIVE（可领取）→ FINISHED（领完）/ EXPIRED（过期已退回）。
 * 配置默认值见 config/red-packet.config.ts，运行期由系统配置中心 chat.redPacket 覆盖（管理员在线可调）。
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from '../game/player.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ChatService } from './chat.service';
import {
  HARD_CURRENCY_NAMES,
  RedPacketConfig,
} from '../../config/red-packet.config';

/** 红包状态常量 */
const STATUS_ACTIVE = 'ACTIVE';
const STATUS_FINISHED = 'FINISHED';
const STATUS_EXPIRED = 'EXPIRED';

/** 红包玩法常量：NORMAL=谁都能领；TARGET=仅指定领取人；PASSCODE=口令红包 */
const PACKET_TYPE_NORMAL = 'NORMAL';
const PACKET_TYPE_TARGET = 'TARGET';
const PACKET_TYPE_PASSCODE = 'PASSCODE';

/** 世界频道房间名（Socket.IO room，消息广播用） */
const WORLD_CHANNEL_NAME = '世界频道';

/** 单次查询/返回的红包条数上限 */
const MAX_PACKETS_PER_QUERY = 50;

/** 单轮过期扫描处理的红包数上限（避免一次扫太多拖慢定时任务） */
const SWEEP_BATCH_SIZE = 200;

/** 发红包入参：单个道具条目 */
export interface RedPacketItemInput {
  /** 道具名（背包中的 name） */
  name: string;
  /** 放入数量（整数份） */
  quantity: number;
}

/** 发红包入参（整体） */
export interface RedPacketCreateInput {
  /** 祝福语/备注 */
  greeting?: string;
  /** 道具清单 */
  items?: RedPacketItemInput[];
  /** 玩法：NORMAL（默认，谁都能领）/ TARGET（指定领取人）/ PASSCODE（口令红包） */
  packetType?: string;
  /** 专属红包的领取人：用户名 / 昵称 / 数字用户ID */
  target?: string | number;
  /** 口令红包的口令 */
  passcode?: string;
}

/** 红包视图（返回给前端/广播的统一结构） */
export interface RedPacketView {
  id: number;
  senderId: number;
  senderName: string;
  greeting: string;
  status: string;
  totalCount: number;
  claimedCount: number;
  expireAt: string;
  createdAt: string;
  /** 道具摘要文本，如「钻石×3、木头×10」 */
  summary: string;
  items: Array<{ name: string; type: string; quantity: number; claimedQuantity: number }>;
  /** 当前查看者在该红包中领到的东西（未领取为 null） */
  myClaim: { itemName: string; quantity: number } | null;
  /** 是否已过期（前端按钮态兜底判断用） */
  expired: boolean;
  /** 玩法：NORMAL / TARGET / PASSCODE */
  packetType: string;
  /** 专属红包的指定领取人ID（非专属为 null） */
  targetUserId: number | null;
  /** 专属红包的指定领取人昵称（非专属为 null） */
  targetUserName: string | null;
  /**
   * 口令红包的口令：仅发送者本人能拿到（用于自己查看/提醒），其他人一律为 null。
   * 非口令红包为 null。
   */
  passcode: string | null;
}

@Injectable()
export class RedPacketService {
  private readonly logger = new Logger(RedPacketService.name);

  /** 过期扫描进行中标记：防止上一轮没跑完又起一轮 */
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly chatService: ChatService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  /**
   * 读取生效配置：系统配置中心（管理员在线可改）优先，缺失/损坏时回退代码默认值。
   */
  async getConfig(): Promise<RedPacketConfig> {
    return this.systemConfigService.getRedPacketConfig();
  }

  /**
   * 可放入红包的道具列表（读发送者背包后的「可选清单」）。
   * 过滤规则（均由配置控制）：
   * - 数量为 0 的条目不展示；
   * - 默认排除装备类（装备为独立实例，红包按名发放会丢词条）；
   * - 默认排除硬通货（钻石/召唤券/数据核心，其增减需走货币审计）。
   */
  async listSendableItems(userId: number) {
    const cfg = await this.getConfig();
    const playerData = await this.playerService.getPlayerData(userId);
    const backpack = this.playerService.getBackpackItems(playerData.player);
    return this.pickSendableItems(backpack, cfg);
  }

  /** 从背包数组里筛选可选道具（纯函数，便于复用与测试） */
  private pickSendableItems(backpack: any[], cfg: RedPacketConfig) {
    return backpack
      .filter((it: any) => it && typeof it.name === 'string' && it.name)
      .map((it: any) => ({
        name: String(it.name),
        type: String(it.type || ''),
        // 数量只读规范键 quantity：别名键在读写档边界已归一，此处读同义键 count 会拿到 undefined
        quantity: Math.floor(Number(it.quantity ?? 0)),
      }))
      .filter((it) => Number.isFinite(it.quantity) && it.quantity > 0)
      .filter((it) => cfg.allowEquipment || it.type !== '装备')
      .filter((it) => cfg.allowCurrency || !HARD_CURRENCY_NAMES.includes(it.name))
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  }

  /**
   * 解析红包玩法：把前端传来的 packetType / target / passcode 归一化为入库字段。
   * - NORMAL：谁都能领（默认）
   * - TARGET（专属红包）：解析指定领取人（支持 用户名/昵称/数字用户ID），不能指定自己
   * - PASSCODE（口令红包）：校验口令长度；玩法开关与长度上限均由系统配置控制
   */
  private async resolvePacketType(
    userId: number,
    input: RedPacketCreateInput,
    cfg: RedPacketConfig,
  ): Promise<{ packetType: string; targetUserId: number | null; passcode: string | null }> {
    const requested = String(input?.packetType || PACKET_TYPE_NORMAL).trim().toUpperCase();

    if (requested === PACKET_TYPE_TARGET) {
      if (!cfg.enableTargeted) {
        throw new BadRequestException('专属红包当前未开放');
      }
      const name = String(input?.target ?? '').trim();
      if (!name) {
        throw new BadRequestException('专属红包需要指定领取人');
      }
      // 与 @提及 同一套解析口径：数字ID → 用户名 → 昵称
      const target = /^\d+$/.test(name)
        ? await this.prisma.user.findUnique({ where: { id: Number(name) } })
        : ((await this.prisma.user.findFirst({ where: { username: name } })) ??
          (await this.prisma.user.findFirst({ where: { nickname: name } })));
      if (!target) {
        throw new BadRequestException(`未找到玩家「${name}」，请确认用户名或昵称`);
      }
      if (target.id === userId) {
        throw new BadRequestException('不能给自己发专属红包，换成普通红包即可');
      }
      return { packetType: PACKET_TYPE_TARGET, targetUserId: target.id, passcode: null };
    }

    if (requested === PACKET_TYPE_PASSCODE) {
      if (!cfg.enablePasscode) {
        throw new BadRequestException('口令红包当前未开放');
      }
      const code = String(input?.passcode || '').trim().slice(0, cfg.maxPasscodeLength);
      if (code.length < cfg.minPasscodeLength) {
        throw new BadRequestException(
          `口令至少 ${cfg.minPasscodeLength} 个字符（最多 ${cfg.maxPasscodeLength} 个）`,
        );
      }
      return { packetType: PACKET_TYPE_PASSCODE, targetUserId: null, passcode: code };
    }

    return { packetType: PACKET_TYPE_NORMAL, targetUserId: null, passcode: null };
  }

  /** 口令比对：默认忽略大小写与首尾空格（配置 caseSensitivePasscode=true 时严格比对） */
  private passcodeMatch(expected: string | null, actual: string | undefined, caseSensitive: boolean): boolean {
    const right = String(expected || '').trim();
    const give = String(actual || '').trim();
    if (!right) return false;
    return caseSensitive ? right === give : right.toLowerCase() === give.toLowerCase();
  }

  /**
   * 发红包：校验 → 扣背包 → 落库 → 公屏广播（type=redpacket 消息 + 红包视图）
   * @returns packet=红包视图，message=已广播的公屏消息（含 redPacket 字段）
   */
  async createPacket(userId: number, input: RedPacketCreateInput) {
    const cfg = await this.getConfig();
    const greeting = String(input?.greeting || '').trim().slice(0, cfg.maxGreetingLength);
    // 玩法解析：专属红包 → 解析指定领取人；口令红包 → 校验口令（开关/长度由配置控制）
    const play = await this.resolvePacketType(userId, input, cfg);

    // 1. 入参归一化：同名道具合并数量，丢弃非法条目
    const merged = new Map<string, number>();
    for (const raw of input?.items || []) {
      const name = String(raw?.name || '').trim();
      const quantity = Math.floor(Number(raw?.quantity || 0));
      if (!name || !Number.isFinite(quantity) || quantity <= 0) continue;
      merged.set(name, (merged.get(name) || 0) + quantity);
    }
    const entries = [...merged.entries()].map(([name, quantity]) => ({ name, quantity }));
    if (entries.length === 0) {
      throw new BadRequestException('请先选择要放入红包的道具');
    }
    if (entries.length > cfg.maxItemKinds) {
      throw new BadRequestException(`一个红包最多放 ${cfg.maxItemKinds} 种道具`);
    }
    const totalCount = entries.reduce((sum, e) => sum + e.quantity, 0);
    if (totalCount > cfg.maxTotalCount) {
      throw new BadRequestException(`一个红包最多 ${cfg.maxTotalCount} 份`);
    }
    if (totalCount < cfg.minTotalCount) {
      throw new BadRequestException(`一个红包至少 ${cfg.minTotalCount} 份`);
    }

    // 2. 校验背包：道具必须在「可发放清单」里且数量充足（一次读快照，避免边扣边读）
    const playerData = await this.playerService.getPlayerData(userId);
    const sendableItems = this.pickSendableItems(this.playerService.getBackpackItems(playerData.player), cfg);
    const sendable = new Map(sendableItems.map((it) => [it.name, it.quantity]));
    const typeByName = new Map(sendableItems.map((it) => [it.name, it.type]));
    for (const entry of entries) {
      const owned = sendable.get(entry.name);
      if (owned === undefined) {
        throw new BadRequestException(`背包中没有「${entry.name}」，或该道具不允许放入红包`);
      }
      if (owned < entry.quantity) {
        throw new BadRequestException(`「${entry.name}」数量不足（当前拥有 ${owned} 个）`);
      }
    }

    // 3. 扣除背包：逐个扣除，中途失败则回滚已扣部分（绝不出现「钱扣了红包没发出去」）
    const deducted: Array<{ name: string; quantity: number }> = [];
    for (const entry of entries) {
      const ok = await this.playerService.removeFromBackpack(userId, entry.name, entry.quantity);
      if (!ok) {
        await this.refundToBackpack(userId, deducted);
        throw new BadRequestException(`扣除「${entry.name}」失败，红包未发出`);
      }
      deducted.push(entry);
    }

    // 4. 落库红包与道具条目；落库失败则把已扣道具退还，保证玩家不亏
    let packet: any;
    try {
      const expireAt = new Date(Date.now() + cfg.expireHours * 3600 * 1000);
      const channel = await this.chatService.ensureDefaultChannel();
      packet = await this.prisma.redPacket.create({
        data: {
          senderId: userId,
          channelId: channel.id,
          greeting,
          packetType: play.packetType,
          targetUserId: play.targetUserId,
          passcode: play.passcode,
          status: STATUS_ACTIVE,
          totalCount,
          claimedCount: 0,
          expireAt,
          items: {
            create: entries.map((entry) => ({
              name: entry.name,
              type: typeByName.get(entry.name) || '',
              quantity: entry.quantity,
            })),
          },
        },
        include: { items: true },
      });
    } catch (err: any) {
      // 退还失败不覆盖原始错误（退还异常已在 refundToBackpack 内记录），避免玩家只看到「退还失败」
      try {
        await this.refundToBackpack(userId, deducted);
      } catch (refundErr: any) {
        this.logger.error(`红包落库失败后，道具退还异常: ${refundErr?.message ?? refundErr}`);
      }
      this.logger.error(`红包落库失败，已尝试退还道具: ${err?.message ?? err}`);
      throw new BadRequestException('红包创建失败，道具已退回背包，请重试');
    }

    // 5. 公屏消息（type=redpacket 走悬浮世界聊天窗；refId 关联红包，前端据此渲染领取卡片）
    const channel = await this.chatService.ensureDefaultChannel();
    const view = await this.buildView(packet, userId);
    const message = await this.chatService.saveMessage({
      channelId: channel.id,
      senderId: userId,
      type: 'redpacket',
      content: this.buildSummaryText(view),
      refId: packet.id,
    });
    // 消息上附带红包实时视图，前端收到即可直接渲染（无需再发一次查询）
    const payload = { ...message, redPacket: view };
    this.chatService.emitToChannel(WORLD_CHANNEL_NAME, 'chat:message', payload);

    // 专属红包：给被指定的人发一条定向提醒（per-user 房间，与 @提及 同一套通道）
    if (play.packetType === PACKET_TYPE_TARGET && play.targetUserId) {
      this.chatService.emitToUser(play.targetUserId, 'chat:redpacket-target', {
        packetId: packet.id,
        from: view.senderName,
        greeting,
        totalCount: view.totalCount,
        summary: view.summary,
        at: new Date().toISOString(),
      });
    }
    return { packet: view, message: payload };
  }

  /**
   * 领取红包：先到先得，每人每个红包限领 1 份。
   * 名额用「条件更新」在事务内抢占，抢到后再把道具打进领取者背包；
   * 背包写入失败时回滚名额，避免「记录说领到了但背包没有」。
   */
  async claimPacket(userId: number, packetId: number, inputPasscode?: string) {
    const cfg = await this.getConfig();
    const picked = await this.prisma.$transaction(async (tx) => {
      const packet = await tx.redPacket.findUnique({ where: { id: packetId } });
      if (!packet) throw new NotFoundException('红包不存在或已被清理');
      if (packet.status === STATUS_EXPIRED || packet.expireAt.getTime() <= Date.now()) {
        throw new BadRequestException('这个红包已经过期啦');
      }
      if (packet.status !== STATUS_ACTIVE) {
        throw new BadRequestException('这个红包已经被抢完了');
      }
      // 专属红包：只有指定领取人能领（前端按钮已置灰，这里是服务端兜底）
      if (packet.packetType === PACKET_TYPE_TARGET) {
        if (!packet.targetUserId || packet.targetUserId !== userId) {
          throw new BadRequestException('这是专属红包，只有指定的玩家才能领取');
        }
      }
      // 口令红包：口令必须一致（默认忽略大小写与首尾空格）
      if (packet.packetType === PACKET_TYPE_PASSCODE) {
        if (!this.passcodeMatch(packet.passcode, inputPasscode, cfg.caseSensitivePasscode)) {
          throw new BadRequestException('口令不对，再想想？');
        }
      }
      // 同一玩家同一红包只能领一次（DB 有唯一约束兜底）
      const claimed = await tx.redPacketClaim.findUnique({
        where: { packetId_userId: { packetId, userId } },
      });
      if (claimed) {
        throw new BadRequestException(`你已经领过这个红包了（${claimed.itemName}×${claimed.quantity}）`);
      }
      // 顺序抢占第一份还没被领完的道具：条件更新保证并发下不会超发
      const items = await tx.redPacketItem.findMany({ where: { packetId }, orderBy: { id: 'asc' } });
      let item: (typeof items)[number] | null = null;
      for (const candidate of items) {
        const res = await tx.redPacketItem.updateMany({
          where: { id: candidate.id, claimedQuantity: { lt: candidate.quantity } },
          data: { claimedQuantity: { increment: 1 } },
        });
        if (res.count > 0) {
          item = candidate;
          break;
        }
      }
      if (!item) {
        // 条目已空但状态还没跟上：顺手收口，避免一直显示可领取
        await tx.redPacket.update({ where: { id: packetId }, data: { status: STATUS_FINISHED } });
        throw new BadRequestException('这个红包已经被抢完了');
      }
      const claimedCount = packet.claimedCount + 1;
      await tx.redPacket.update({
        where: { id: packetId },
        data: {
          claimedCount,
          status: claimedCount >= packet.totalCount ? STATUS_FINISHED : STATUS_ACTIVE,
        },
      });
      await tx.redPacketClaim.create({
        data: { packetId, userId, itemName: item.name, quantity: 1 },
      });
      return { name: item.name, quantity: 1 };
    });

    // 发货：走玩家写路径（Actor 串行邮箱），失败则回滚名额
    const ok = await this.playerService.addToBackpack(userId, picked.name, picked.quantity);
    if (!ok) {
      await this.rollbackClaim(packetId, userId, picked);
      throw new BadRequestException('发放失败，请稍后重试');
    }

    const packet = await this.prisma.redPacket.findUnique({ where: { id: packetId } });
    const view = packet ? await this.buildView(packet, userId) : null;
    if (packet) {
      // 广播用「中立视图」(viewerId=0，不带 myClaim)：领取记录因人而异，
      // 各端只更新进度，自己的领取状态由本地 store 保留（见前端 upsertRedPacket）
      const broadcastView = await this.buildView(packet, 0);
      this.chatService.emitToChannel(WORLD_CHANNEL_NAME, 'chat:redpacket', broadcastView);
    }
    return { itemName: picked.name, quantity: picked.quantity, packet: view };
  }

  /**
   * 查询红包状态列表（前端进频道时把未结束的红包卡片状态对齐）。
   * @param viewerId 查看者用户ID（用于返回 myClaim）
   * @param ids 指定红包ID（历史消息按 refId 批量查询）；为空则返回时间窗内的最近红包
   */
  async listPackets(viewerId: number, ids?: number[]) {
    const cfg = await this.getConfig();
    const idList = (ids || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
    const where = idList.length
      ? { id: { in: idList.slice(0, MAX_PACKETS_PER_QUERY) } }
      : { createdAt: { gte: new Date(Date.now() - cfg.historyHours * 3600 * 1000) } };
    const rows = await this.prisma.redPacket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_PACKETS_PER_QUERY,
      include: {
        items: true,
        sender: { select: { id: true, username: true, nickname: true } },
        // 专属红包的指定领取人：用于卡片上显示「仅限 XXX 领取」
        targetUser: { select: { id: true, username: true, nickname: true } },
        claims: { where: { userId: viewerId } },
      },
    });
    return Promise.all(rows.map((row) => this.buildView(row, viewerId)));
  }

  /**
   * 「我的红包」面板数据：我发出的 / 我领到的 / 退回明细。
   *
   * 退回明细不额外建表：红包过期时已把「剩余份额」一次性退回到发送者背包，
   * 而剩余份额 = Σ(quantity - claimedQuantity)，且状态变为 EXPIRED 后份额不再变动，
   * 因此可直接由条目快照精确还原「退回了什么、退了多少」。
   */
  async getMyRedPackets(userId: number) {
    const cfg = await this.getConfig();
    const [sent, claims] = await Promise.all([
      this.prisma.redPacket.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: 'desc' },
        take: cfg.myPanelLimit,
        include: {
          items: true,
          // 专属红包的指定领取人（面板上显示「仅 XXX 可领」）
          targetUser: { select: { id: true, username: true, nickname: true } },
        },
      }),
      this.prisma.redPacketClaim.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: cfg.myPanelLimit,
        include: {
          packet: {
            select: {
              id: true,
              senderId: true,
              greeting: true,
              packetType: true,
              status: true,
              sender: { select: { id: true, username: true, nickname: true } },
            },
          },
        },
      }),
    ]);

    // 发出列表：带上「剩余未领」明细（过期后再看即当时的退回量）
    const sentRows = sent.map((packet) => {
      const items = (packet.items || []).map((item) => ({
        name: item.name,
        quantity: Math.max(0, item.quantity - item.claimedQuantity),
      }));
      const remaining = items.filter((item) => item.quantity > 0);
      const expired = packet.status === STATUS_EXPIRED || packet.expireAt.getTime() <= Date.now();
      return {
        id: packet.id,
        packetType: packet.packetType || PACKET_TYPE_NORMAL,
        greeting: packet.greeting || '',
        status: packet.status,
        totalCount: packet.totalCount,
        claimedCount: packet.claimedCount,
        summary: (packet.items || []).map((item) => `${item.name}×${item.quantity}`).join('、'),
        remainingSummary: remaining.map((item) => `${item.name}×${item.quantity}`).join('、'),
        remaining,
        targetUserName: packet.targetUser
          ? packet.targetUser.nickname || packet.targetUser.username
          : null,
        createdAt: packet.createdAt.toISOString(),
        expireAt: packet.expireAt.toISOString(),
        expired,
      };
    });

    // 领到列表：来自谁、领到什么、什么时候领的
    const claimedRows = claims.map((claim) => ({
      packetId: claim.packetId,
      itemName: claim.itemName,
      quantity: claim.quantity,
      from: claim.packet?.sender
        ? claim.packet.sender.nickname || claim.packet.sender.username
        : '未知玩家',
      packetType: claim.packet?.packetType || PACKET_TYPE_NORMAL,
      greeting: claim.packet?.greeting || '',
      createdAt: claim.createdAt.toISOString(),
    }));

    // 退回明细：仅过期红包；其「剩余份额」就是过期时退回发送者背包的道具
    const refundRows = sentRows
      .filter((row) => row.status === STATUS_EXPIRED)
      .map((row) => ({
        packetId: row.id,
        packetType: row.packetType,
        greeting: row.greeting,
        totalCount: row.totalCount,
        claimedCount: row.claimedCount,
        remainingSummary: row.remainingSummary,
        items: row.remaining,
        refundedAt: row.expireAt,
        createdAt: row.createdAt,
      }));

    return { sent: sentRows, claimed: claimedRows, refunds: refundRows };
  }

  /**
   * 过期红包扫描（cron 每 5 分钟一轮，单轮最多 SWEEP_BATCH_SIZE 个）：
   * 状态抢占（ACTIVE→EXPIRED 的条件更新保证只处理一次）→ 退还剩余份额 → 通知发送者并广播卡片状态。
   */
  @Cron('0 */5 * * * *')
  async sweepExpired(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = await this.prisma.redPacket.findMany({
        where: { status: STATUS_ACTIVE, expireAt: { lte: new Date() } },
        include: { items: true },
        take: SWEEP_BATCH_SIZE,
      });
      for (const packet of rows) {
        // 抢占：只有把 ACTIVE 改成 EXPIRED 成功的那一次执行才负责退款（幂等防重）
        const acquired = await this.prisma.redPacket.updateMany({
          where: { id: packet.id, status: STATUS_ACTIVE },
          data: { status: STATUS_EXPIRED },
        });
        if (acquired.count === 0) continue;

        const refund = packet.items
          .map((item) => ({ name: item.name, quantity: item.quantity - item.claimedQuantity }))
          .filter((item) => item.quantity > 0);

        try {
          await this.refundToBackpack(packet.senderId, refund);
        } catch (err: any) {
          // 退款失败：把状态改回 ACTIVE，下一轮扫描重试，避免份额凭空消失
          await this.prisma.redPacket.updateMany({
            where: { id: packet.id, status: STATUS_EXPIRED },
            data: { status: STATUS_ACTIVE },
          });
          this.logger.error(`红包 #${packet.id} 过期退款失败，已回滚状态等待重试: ${err?.message ?? err}`);
          continue;
        }

        // 通知发送者「哪些东西退回来了」，并广播卡片状态
        if (refund.length > 0) {
          this.chatService.emitToUser(packet.senderId, 'chat:redpacket-refund', {
            packetId: packet.id,
            items: refund,
          });
        }
        // 中立视图广播（不带 myClaim），各端只需刷新为「已过期」
        const view = await this.buildView({ ...packet, status: STATUS_EXPIRED }, 0);
        this.chatService.emitToChannel(WORLD_CHANNEL_NAME, 'chat:redpacket', view);
      }
      if (rows.length > 0) {
        this.logger.log(`过期红包处理完成：本轮 ${rows.length} 个`);
      }
    } catch (err: any) {
      this.logger.error(`过期红包扫描失败: ${err?.message ?? err}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** 把一批道具退回指定玩家背包（逐个退，单个失败只记日志不中断，避免卡住定时任务） */
  private async refundToBackpack(userId: number, items: Array<{ name: string; quantity: number }>) {
    for (const item of items) {
      if (!item?.name || !(item.quantity > 0)) continue;
      const ok = await this.playerService.addToBackpack(userId, item.name, item.quantity);
      if (!ok) {
        // 抛出交由上层决定（创建流程回滚 / 过期扫描回滚状态重试）
        throw new Error(`退还 ${item.name}×${item.quantity} 失败`);
      }
    }
  }

  /** 领取发货失败时回滚名额：份额还回去、领取记录删除、红包状态回到可领取 */
  private async rollbackClaim(packetId: number, userId: number, picked: { name: string; quantity: number }) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.redPacketClaim.deleteMany({ where: { packetId, userId } });
        await tx.redPacketItem.updateMany({
          where: { packetId, name: picked.name, claimedQuantity: { gt: 0 } },
          data: { claimedQuantity: { decrement: picked.quantity } },
        });
        await tx.redPacket.updateMany({
          where: { id: packetId, claimedCount: { gt: 0 } },
          data: { claimedCount: { decrement: picked.quantity }, status: STATUS_ACTIVE },
        });
      });
      this.logger.warn(`红包 #${packetId} 发货失败，已回滚名额（${picked.name}×${picked.quantity}）`);
    } catch (err: any) {
      this.logger.error(`红包 #${packetId} 名额回滚失败，需人工核对: ${err?.message ?? err}`);
    }
  }

  /** 消息文案：红包在公屏消息流中的可读摘要（专属/口令红包带标记） */
  private buildSummaryText(view: RedPacketView): string {
    const greeting = view.greeting ? `：${view.greeting}` : '';
    const tag =
      view.packetType === PACKET_TYPE_TARGET
        ? '专属'
        : view.packetType === PACKET_TYPE_PASSCODE
          ? '口令'
          : '';
    const target =
      view.packetType === PACKET_TYPE_TARGET && view.targetUserName ? ` → ${view.targetUserName}` : '';
    return `🧧 ${view.senderName} 发了一个${tag}红包（${view.totalCount} 份）${target}${greeting}`;
  }

  /**
   * 组装红包视图：把 DB 行转成前端直接可渲染的结构。
   * @param row 红包行（需含 items；sender/claims 可选，缺省时按需补查）
   * @param viewerId 查看者用户ID，决定 myClaim 与口令回显；0=中立视图（广播用）
   */
  private async buildView(row: any, viewerId: number): Promise<RedPacketView> {
    let sender = row.sender;
    if (!sender && row.senderId) {
      sender = await this.prisma.user.findUnique({
        where: { id: row.senderId },
        select: { id: true, username: true, nickname: true },
      });
    }
    // 专属红包的「指定领取人」信息（列表查询会 include；广播等场景按需补查）
    let targetUser = row.targetUser;
    if (!targetUser && row.targetUserId) {
      targetUser = await this.prisma.user.findUnique({
        where: { id: row.targetUserId },
        select: { id: true, username: true, nickname: true },
      });
    }
    let myClaim = Array.isArray(row.claims) ? row.claims[0] : undefined;
    if (!myClaim && viewerId) {
      myClaim =
        (await this.prisma.redPacketClaim.findUnique({
          where: { packetId_userId: { packetId: row.id, userId: viewerId } },
        })) || undefined;
    }
    const items = (row.items || []).map((item: any) => ({
      name: item.name,
      type: item.type || '',
      quantity: item.quantity,
      claimedQuantity: item.claimedQuantity,
    }));
    const senderName = sender?.nickname || sender?.username || '某位玩家';
    return {
      id: row.id,
      senderId: row.senderId,
      senderName,
      greeting: row.greeting || '',
      status: row.status,
      totalCount: row.totalCount,
      claimedCount: row.claimedCount,
      expireAt: new Date(row.expireAt).toISOString(),
      createdAt: new Date(row.createdAt).toISOString(),
      summary: items
        .map((item: any) => `${item.name}×${item.quantity}`)
        .join('、'),
      items,
      myClaim: myClaim ? { itemName: myClaim.itemName, quantity: myClaim.quantity } : null,
      expired: row.status === STATUS_EXPIRED || new Date(row.expireAt).getTime() <= Date.now(),
      packetType: row.packetType || PACKET_TYPE_NORMAL,
      targetUserId: row.targetUserId ?? null,
      targetUserName: targetUser ? targetUser.nickname || targetUser.username : null,
      // 口令只回给发送者本人（前端用于回显"我设的口令"），其他人一律拿不到
      passcode:
        (row.packetType || PACKET_TYPE_NORMAL) === PACKET_TYPE_PASSCODE &&
        viewerId &&
        row.senderId === viewerId
          ? row.passcode || ''
          : null,
    };
  }
}
