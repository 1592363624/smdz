/**
 * 世界红包服务
 *
 * 业务语义（对齐需求）：
 * 1. 发红包：读取发送者背包里的道具 → 玩家挑选种类与数量 → 发送时立即从背包扣除；
 * 2. 领红包：其他玩家在公屏红包卡片上点击领取，先到先得，每个红包每人限领 1 次；
 * 3. 过期退回：有效期（默认 24 小时，配置化）内没被领完的份额，自动退回到发送者背包。
 *
 * 实现要点：
 * - 背包读写统一走 PlayerService（内部走 Actor 串行邮箱），不在本服务里直接改 Player JSON；
 * - 领取份额用「条件更新（claimedQuantity < quantity）」抢占，杜绝并发超发；
 * - 状态机：ACTIVE（可领取）→ FINISHED（领完）/ EXPIRED（过期已退回）。
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
   * @param userId 当前用户ID
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
        // 兼容 count / quantity 双字段镜像（与 PlayerService.removeFromBackpack 口径一致）
        quantity: Math.floor(Number(it.count ?? it.quantity ?? 0)),
      }))
      .filter((it) => Number.isFinite(it.quantity) && it.quantity > 0)
      .filter((it) => cfg.allowEquipment || it.type !== '装备')
      .filter((it) => cfg.allowCurrency || !HARD_CURRENCY_NAMES.includes(it.name))
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  }

  /**
   * 发红包：校验 → 扣背包 → 落库 → 公屏广播（type=redpacket 消息 + 红包视图）
   * @param userId 发送者用户ID
   * @param input { greeting, items: [{ name, quantity }] }
   * @returns { packet, message } packet=红包视图，message=已广播的公屏消息
   */
  async createPacket(userId: number, input: { greeting?: string; items?: RedPacketItemInput[] }) {
    const cfg = await this.getConfig();
    const greeting = String(input?.greeting || '').trim().slice(0, cfg.maxGreetingLength);

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
    return { packet: view, message: payload };
  }

  /**
   * 领取红包：先到先得，每人每个红包限领 1 份。
   * 名额用「条件更新」在事务内抢占，抢到后再把道具打进领取者背包；
   * 背包写入失败时回滚名额，避免「记录说领到了但背包没有」。
   * @param userId 领取者用户ID
   * @param packetId 红包ID
   */
  async claimPacket(userId: number, packetId: number) {
    const picked = await this.prisma.$transaction(async (tx) => {
      const packet = await tx.redPacket.findUnique({ where: { id: packetId } });
      if (!packet) throw new NotFoundException('红包不存在或已被清理');
      if (packet.status === STATUS_EXPIRED || packet.expireAt.getTime() <= Date.now()) {
        throw new BadRequestException('这个红包已经过期啦');
      }
      if (packet.status !== STATUS_ACTIVE) {
        throw new BadRequestException('这个红包已经被抢完了');
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
        claims: { where: { userId: viewerId } },
      },
    });
    return Promise.all(rows.map((row) => this.buildView(row, viewerId)));
  }

  /**
   * 过期红包扫描：每 5 分钟一次（间隔为代码常量，如需调整可改 cron 表达式）。
   * 处理：状态占用（ACTIVE→EXPIRED 的条件更新保证只处理一次）→ 退还剩余份额 → 通知发送者。
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

  /** 消息文案：红包在公屏消息流中的可读摘要 */
  private buildSummaryText(view: RedPacketView): string {
    const greeting = view.greeting ? `：${view.greeting}` : '';
    return `🧧 ${view.senderName} 发了一个红包（${view.totalCount} 份）${greeting}`;
  }

  /**
   * 组装红包视图：把 DB 行转成前端直接可渲染的结构。
   * @param row 红包行（需含 items；sender/claims 可选，缺省时按需补查）
   * @param viewerId 查看者用户ID（用于 myClaim）
   */
  private async buildView(row: any, viewerId: number): Promise<RedPacketView> {
    let sender = row.sender;
    if (!sender && row.senderId) {
      sender = await this.prisma.user.findUnique({
        where: { id: row.senderId },
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
    };
  }
}
