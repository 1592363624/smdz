/**
 * 在线统计服务
 * 追踪当前 WebSocket 在线玩家，提供总玩家数、在线玩家数，以及「在线玩家名单」
 * （供网页左下角状态栏悬停「在线」时展示，以及上下线提示使用）。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GlobalConfig } from '../../config/global.config';

/** 在线玩家显示名查询所需的用户字段（账号信息 + 角色派生名） */
type PresenceUserRow = {
  id: number;
  username: string;
  nickname: string | null;
  player: { name: string | null; baseName: string | null } | null;
};

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  /**
   * 当前在线玩家连接计数（静态字段：即使出现多个实例也共享同一份数据）。
   * 按连接数引用计数而非简单 Set 去重：同一账号开多个标签页时，
   * 只有最后一个连接断开才判定为离线，避免关闭单个标签页误报离线。
   * Map 的插入顺序 ≈ 上线先后，取名单前 N 个时按此顺序（先上线的先展示）。
   */
  private static onlineUsers = new Map<number, number>();

  /**
   * 在线玩家「显示名」缓存：userId → { name, at }（降 DB 压力）
   *
   * 关键：缓存的是「名字映射」而不是「最终名单」。
   * 名单每次按「当前在线 ids」实时组装，所以谁上线/谁离线都会立刻反映——
   * 若直接缓存最终名单，会出现「在线 1 人但名单为空」这类人数与名单错位的问题。
   * 缓存的价值：上下线时只需为「缓存里没有的新 id」增量查库，反复上下线的老玩家直接命中，
   * 避免每次统计广播都全量查库。TTL 决定名字新鲜度（改名后最迟 TTL 生效）。
   */
  private onlineNameCache = new Map<number, { name: string; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** 用户上线（连接数 +1） */
  userOnline(userId: number): void {
    StatsService.onlineUsers.set(userId, (StatsService.onlineUsers.get(userId) || 0) + 1);
  }

  /** 用户下线（连接数 -1，减到 0 才判定离线） */
  userOffline(userId: number): void {
    const count = (StatsService.onlineUsers.get(userId) || 0) - 1;
    if (count > 0) {
      StatsService.onlineUsers.set(userId, count);
    } else {
      StatsService.onlineUsers.delete(userId);
    }
  }

  /** 获取在线人数 */
  getOnlineCount(): number {
    return StatsService.onlineUsers.size;
  }

  /**
   * 判断指定用户是否在线
   * @param userId 用户ID
   * @returns true=在线 / false=离线
   */
  isOnline(userId: number): boolean {
    return StatsService.onlineUsers.has(userId);
  }

  /**
   * 获取当前在线用户ID集合（只读副本，供查询附近玩家时做在线标记）
   */
  getOnlineUserIds(): Set<number> {
    return new Set(StatsService.onlineUsers.keys());
  }

  /** 获取总注册用户数（User 表的记录数） */
  async getTotalPlayers(): Promise<number> {
    return this.prisma.user.count();
  }

  /**
   * 取在线玩家名单条数上限（配置项，见 GlobalConfig.presence.onlineListLimit）
   * 通过环境变量 PRESENCE_ONLINE_LIST_LIMIT 可覆盖，无需改代码。
   */
  getOnlineListLimit(): number {
    const limit = Number(GlobalConfig.getInstance().presence.onlineListLimit);
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  /**
   * 取在线玩家显示名缓存时长（毫秒，配置项见 GlobalConfig.presence.onlineListCacheTtlMs）
   * 返回 0 表示不启用缓存（每次都按需查库）。
   */
  getOnlineNameCacheTtlMs(): number {
    const ttl = Number(GlobalConfig.getInstance().presence.onlineListCacheTtlMs);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  }

  /** 主动作废显示名缓存（需要立刻反映改名等变更时调用） */
  invalidateOnlineNameCache(): void {
    this.onlineNameCache.clear();
  }

  /**
   * 获取在线玩家显示名清单（最多 limit 条）
   *
   * 名字优先级与游戏内展示保持一致：角色派生名 > 角色基础名 > 账号昵称 > 用户名。
   * 只取前 limit 个在线用户，避免大服一次广播带出超大名单（前端以"另有 X 人"补足）。
   *
   * 性能：名字按 onlineListCacheTtlMs 缓存（默认 60 秒）。上下线都会触发统计广播，
   * 玩家进出频繁时如果每次都全量查库取名，会形成明显的数据库热点；
   * 这里缓存「id → 名字」映射，名单本身每次按当前在线 ids 实时组装，
   * 因此上下线即时生效，只有新出现的 id 才需要增量查库。
   *
   * @param limit 返回条数上限，缺省取配置值
   */
  async getOnlineDisplayNames(limit?: number): Promise<string[]> {
    const max = Math.max(0, Math.floor(Number(limit ?? this.getOnlineListLimit())) || 0);
    if (max === 0) return [];

    // 按上线先后取前 max 个；查库前先截断，减少 IN 条件规模
    const ids = [...StatsService.onlineUsers.keys()].slice(0, max);
    if (!ids.length) {
      this.onlineNameCache.clear();
      return [];
    }

    // 只补齐「未缓存 / 已过期」的 id：新上线的 id 会走增量查询，老玩家直接命中缓存
    const ttl = this.getOnlineNameCacheTtlMs();
    const now = Date.now();
    const stale = ids.filter((id) => {
      const hit = this.onlineNameCache.get(id);
      if (!hit) return true;
      if (ttl === 0) return true; // 缓存关闭：每次重查
      return now - hit.at >= ttl;
    });

    if (stale.length) {
      const users = (await this.prisma.user.findMany({
        where: { id: { in: stale } },
        select: {
          id: true,
          username: true,
          nickname: true,
          player: { select: { name: true, baseName: true } },
        },
      })) as PresenceUserRow[];

      const byId = new Map(users.map((u) => [u.id, u]));
      for (const id of stale) {
        const name = this.displayNameOf(byId.get(id));
        // 查不到名字（账号已不存在等）不写缓存，下次再试，避免把空名固化 60 秒
        if (name) this.onlineNameCache.set(id, { name, at: now });
      }
    }

    // 顺带清理已离线玩家的缓存，避免 Map 随历史登录账号无限增长
    if (this.onlineNameCache.size > StatsService.onlineUsers.size) {
      for (const id of [...this.onlineNameCache.keys()]) {
        if (!StatsService.onlineUsers.has(id)) this.onlineNameCache.delete(id);
      }
    }

    // 按上线先后组装名单；查不到名字的（账号异常）跳过，前端以「另有 X 人」补足
    return ids.map((id) => this.onlineNameCache.get(id)?.name).filter((n): n is string => !!n);
  }

  /**
   * 获取单个用户的显示名（上下线提示用）
   * 与 getOnlineDisplayNames 共用同一套取名规则，保证提示里的名字与名单一致。
   * 查不到时退回「用户{id}」，确保提示文本始终非空。
   */
  async getUserDisplayName(userId: number): Promise<string> {
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        nickname: true,
        player: { select: { name: true, baseName: true } },
      },
    })) as Omit<PresenceUserRow, 'id'> | null;
    return this.displayNameOf(user) || `用户${userId}`;
  }

  /**
   * 获取完整统计信息（含悬停展示用的在线玩家名单）
   * @returns totalPlayers 总注册人数 / onlinePlayers 在线人数 / onlineList 在线玩家名（最多配置上限条）
   */
  async getStats(): Promise<{ totalPlayers: number; onlinePlayers: number; onlineList: string[] }> {
    const [totalPlayers, onlinePlayers, onlineList] = await Promise.all([
      this.getTotalPlayers(),
      Promise.resolve(this.getOnlineCount()),
      this.getOnlineDisplayNames(),
    ]);
    return { totalPlayers, onlinePlayers, onlineList };
  }

  /**
   * 显示名统一取名规则（唯一出口，避免各处拼装不一致）
   * 优先级：角色派生名（含佩戴称号）> 角色基础名 > 账号昵称 > 用户名
   */
  private displayNameOf(
    user: { username?: string | null; nickname?: string | null; player?: { name?: string | null; baseName?: string | null } | null } | null | undefined,
  ): string {
    if (!user) return '';
    return (
      String(user.player?.name || '').trim() ||
      String(user.player?.baseName || '').trim() ||
      String(user.nickname || '').trim() ||
      String(user.username || '').trim()
    );
  }
}
