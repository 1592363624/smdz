/**
 * 玩家权益服务：按玩家发放的「功能特权」「头像框」「称号」三类权益的唯一读写口。
 *
 * ## 为什么需要它
 * 项目里原本只有一种权限：`User.role`（USER/ADMIN/SUPER_ADMIN）。它是**后台身份**，
 * 只能由注册/改库产生，既不会到期，也不能作为玩法奖励发出去。
 * 竞技场赛季奖励要能给出「独一无二的能力」（例如让榜首获得野外批量采集），
 * 就必须把这类口子从「role 判定」改成「能力判定」——本服务即那层能力账本：
 * - 特权会到期、可撤销、带来源与理由，玩法奖励与管理员手工授予共用同一张表；
 * - 角色判定并不删除：管理员仍然天然拥有全部口子（后台测试与活动投放照常）。
 *
 * ## 依赖方向
 * 只依赖 Prisma / PlayerMutateService / SystemConfigService / StaticDataService，
 * 不依赖任何指令域服务，可被采集口、竞技场结算、后台任意注入而不成环。
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerMutateService } from './player-mutate.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { StaticDataService } from './static-data.service';
import { asJsonValue } from '../../common/utils/json-value.util';
import {
  ARENA_CONFIG_KEYS,
  ARENA_PRIVILEGE_DEFS,
  DEFAULT_ARENA_AVATAR_FRAMES,
  normalizeArenaFrames,
  findPrivilegeDef,
  privilegeLabel,
  ArenaAvatarFrameDef,
} from '../../config/arena.config';

/** 权益来源：竞技场赛季 / 管理员手工。同 (userId,key,source) 覆盖续期 */
export type EntitlementSource = 'arenaSeason' | 'admin' | string;

export interface GrantPrivilegeOptions {
  source?: EntitlementSource;
  /** 有效天数；0 或传 permanent=true 表示永久 */
  days?: number;
  permanent?: boolean;
  reason?: string;
  /** 操作人（管理员手工授予时记录） */
  grantedBy?: number;
}

export interface ActivePrivilege {
  key: string;
  name: string;
  source: string;
  reason: string;
  expiresAt: Date | null;
}

/** 称号直发结果：ok=false 时 text 为拒绝原因 */
export interface GrantResult {
  ok: boolean;
  text: string;
}

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mutate: PlayerMutateService,
    private readonly systemConfig: SystemConfigService,
    @Optional() private readonly staticData?: StaticDataService,
  ) {}

  // ==========================================================
  // 功能特权
  // ==========================================================

  /**
   * 授予（或续期）一个功能特权。
   *
   * 续期口径：同一 (userId, key, source) 只保留一行，重复授予从「未过期的现有到期时刻」
   * 起继续累加，避免赛季连拿两次冠军时第二次把第一期的剩余天数覆盖掉。
   */
  async grantPrivilege(
    userId: number,
    key: string,
    opts: GrantPrivilegeOptions = {},
  ): Promise<GrantResult> {
    const privKey = String(key || '').trim();
    if (!privKey) return { ok: false, text: '特权键为空' };
    // 特权键必须在 ARENA_PRIVILEGE_DEFS 登记：写错键名的授予是「静默无效」的，
    // 管理员会以为已经给了玩家批量采集，玩家却怎么也用不了——宁可当场拒。
    if (!findPrivilegeDef(privKey)) {
      return {
        ok: false,
        text: `未知特权键「${privKey}」，可用键：${ARENA_PRIVILEGE_DEFS.map((p) => p.key).join(' / ')}`,
      };
    }
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return { ok: false, text: '玩家不存在' };

    const source = String(opts.source || 'admin');
    const permanent = !!opts.permanent || Number(opts.days) === 0;
    const days = permanent ? 0 : Math.max(0, Math.floor(Number(opts.days) || 0));
    if (!permanent && days <= 0) return { ok: false, text: `「${privilegeLabel(privKey)}」有效天数非法` };

    const existing = await this.prisma.playerPrivilege.findUnique({
      where: { userId_key_source: { userId: uid, key: privKey, source } },
    }).catch(() => null);

    let expiresAt: Date | null = null;
    if (!permanent) {
      const baseRaw = existing?.expiresAt && existing.expiresAt.getTime() > Date.now()
        ? existing.expiresAt
        : new Date();
      expiresAt = new Date(baseRaw.getTime() + days * 24 * 3600 * 1000);
    }

    const data = {
      expiresAt,
      revokedAt: null,
      reason: String(opts.reason ?? existing?.reason ?? ''),
      grantedBy: opts.grantedBy ?? existing?.grantedBy ?? null,
    };
    if (existing) {
      await this.prisma.playerPrivilege.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.playerPrivilege.create({
        data: { userId: uid, key: privKey, source, ...data },
      });
    }
    const label = privilegeLabel(privKey);
    this.logger.log(`玩家 ${uid} 获得特权 ${label}（来源 ${source}，${permanent ? '永久' : `${days}天`}）`);
    return {
      ok: true,
      text: permanent ? `已获得特权「${label}」（永久）` : `已获得特权「${label}」（${days}天）`,
    };
  }

  /**
   * 撤销特权：source 留空则撤销该玩家该键的全部未撤销记录。
   * @returns 实际撤销的行数
   */
  async revokePrivilege(userId: number, key: string, source?: string): Promise<number> {
    const privKey = String(key || '').trim();
    if (!privKey) return 0;
    const result = await this.prisma.playerPrivilege.updateMany({
      where: {
        userId: Number(userId),
        key: privKey,
        ...(source ? { source: String(source) } : {}),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }).catch(() => ({ count: 0 }));
    return Number(result?.count ?? 0);
  }

  /**
   * 取当前生效的特权行（未撤销且未到期）；无则 null。
   * 到期判定放在读取侧，不依赖清理任务，进程重启/漏跑 cron 都不会误放行。
   */
  async activePrivilege(userId: number, key: string): Promise<ActivePrivilege | null> {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return null;
    const privKey = String(key || '').trim();
    if (!privKey) return null;
    const now = new Date();
    const rows = await this.prisma.playerPrivilege.findMany({
      where: { userId: uid, key: privKey, revokedAt: null },
    }).catch(() => [] as any[]);
    const alive = (rows || [])
      .filter((r: any) => !r.expiresAt || new Date(r.expiresAt).getTime() > now.getTime())
      // 多条并存时取到期最晚的一条（永久排在最前）
      .sort((a: any, b: any) => {
        const av = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bv = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
        return bv - av;
      });
    const hit = alive[0];
    if (!hit) return null;
    return {
      key: hit.key,
      name: privilegeLabel(hit.key),
      source: hit.source,
      reason: hit.reason ?? '',
      expiresAt: hit.expiresAt ? new Date(hit.expiresAt) : null,
    };
  }

  /** 特权是否生效（热路径判定用；只关心有无时不必拿整行） */
  async hasPrivilege(userId: number, key: string): Promise<boolean> {
    return !!(await this.activePrivilege(userId, key));
  }

  /** 玩家当前生效的全部特权（面板/后台展示） */
  async listActivePrivileges(userId: number): Promise<ActivePrivilege[]> {
    const now = new Date();
    const rows = await this.prisma.playerPrivilege.findMany({
      where: { userId: Number(userId), revokedAt: null },
    }).catch(() => [] as any[]);
    return (rows || [])
      .filter((r: any) => !r.expiresAt || new Date(r.expiresAt).getTime() > now.getTime())
      .map((r: any) => ({
        key: r.key,
        name: privilegeLabel(r.key),
        source: r.source,
        reason: r.reason ?? '',
        expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
      }));
  }

  /** 某特权的在册持有者（后台审计：谁因为赛季奖励能批量采集） */
  async listPrivilegeHolders(key: string, limit = 50): Promise<Array<{ userId: number; expiresAt: Date | null; reason: string }>> {
    const now = new Date();
    const rows = await this.prisma.playerPrivilege.findMany({
      where: { key: String(key || ''), revokedAt: null },
      orderBy: { expiresAt: 'desc' },
      take: Math.max(1, Math.floor(limit)),
    }).catch(() => [] as any[]);
    return (rows || [])
      .filter((r: any) => !r.expiresAt || new Date(r.expiresAt).getTime() > now.getTime())
      .map((r: any) => ({
        userId: r.userId,
        expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
        reason: r.reason ?? '',
      }));
  }

  /** 特权定义表（后台下拉与文案） */
  privilegeDefs() {
    return ARENA_PRIVILEGE_DEFS;
  }

  // ==========================================================
  // 称号直发（赛季奖励口，与玩家主动「领取称号」区分）
  // ==========================================================

  /**
   * 直接把称号写进玩家（不经 titles.json 的条件校验、不重复发放称号自带奖励）。
   *
   * 为什么不走 FamiliarSystemService.claimTitle：那条口子会校验领取条件、并二次发放
   * 称号自带的资源奖励；赛季奖励的资源已由发放口统一给，走领取口会重复发。
   * 存储形状与领取口完全一致（Player.titles: [{name, equipped}]），历史字符串条目照旧兼容。
   */
  async grantTitle(userId: number, titleName: string): Promise<GrantResult> {
    const name = String(titleName || '').trim();
    if (!name) return { ok: false, text: '称号名为空' };
    const known = typeof this.staticData?.getTitleByName === 'function'
      ? this.staticData.getTitleByName(name)
      : undefined;
    if (!known) {
      // 配置可以先于 titles.json 上线，拒发会让赛季整体卡住；告警但仍发放
      this.logger.warn(`赛季发放了 titles.json 中不存在的称号「${name}」（玩家 ${userId}），请补表`);
    }
    let text = '';
    try {
      await this.mutate.mutate(Number(userId), (ctx) => {
        const titles = asJsonValue<any[]>(ctx.player.titles, []);
        const owned = titles.some((t: any) => (typeof t === 'string' ? t : t?.name) === name);
        if (owned) {
          text = `已拥有称号「${name}」（跳过）`;
          return;
        }
        titles.push({ name, equipped: false });
        ctx.player.titles = titles;
        text = `获得称号「${name}」`;
      });
    } catch (err: any) {
      this.logger.warn(`发放称号失败（玩家 ${userId} / ${name}）: ${err?.message ?? err}`);
      return { ok: false, text: `称号发放失败` };
    }
    return { ok: true, text };
  }

  // ==========================================================
  // 头像框
  // ==========================================================

  /** 头像框定义表（后台可配，arena.avatarFrames） */
  async frameDefs(): Promise<ArenaAvatarFrameDef[]> {
    try {
      const raw = await this.systemConfig.get<any>(ARENA_CONFIG_KEYS.avatarFrames, DEFAULT_ARENA_AVATAR_FRAMES);
      return normalizeArenaFrames(raw);
    } catch {
      return [...DEFAULT_ARENA_AVATAR_FRAMES];
    }
  }

  /** 按键查定义（未配置时回落内置默认，再回落键名本身） */
  async frameDef(frameKey: string): Promise<ArenaAvatarFrameDef> {
    const defs = await this.frameDefs();
    const hit = defs.find((d) => d.key === frameKey)
      ?? DEFAULT_ARENA_AVATAR_FRAMES.find((d) => d.key === frameKey);
    return hit ?? { key: frameKey, name: frameKey, tone: '', description: '' };
  }

  /**
   * 授予头像框。已拥有则视为续领（不重复发、不改佩戴状态），结算可安全重跑。
   */
  async grantFrame(userId: number, frameKey: string, source: EntitlementSource = 'admin'): Promise<GrantResult> {
    const key = String(frameKey || '').trim();
    if (!key) return { ok: false, text: '头像框键为空' };
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return { ok: false, text: '玩家不存在' };
    const def = await this.frameDef(key);
    // 未配置的键照样能发（奖励表可能先于头像框表上线），但要在文案里点明它没有定义，
    // 避免后台看到的是一个"名字就是键"的怪框还以为是正常奖励。
    const known = (await this.frameDefs()).some((d) => d.key === key);
    try {
      const existing = await this.prisma.playerAvatarFrame.findUnique({
        where: { userId_frameKey: { userId: uid, frameKey: key } },
      });
      if (existing) return { ok: true, text: `已拥有头像框「${def.name}」（跳过）` };
      await this.prisma.playerAvatarFrame.create({
        data: { userId: uid, frameKey: key, name: def.name, tone: def.tone, source: String(source), equipped: false },
      });
      return { ok: true, text: `获得头像框「${def.name}」${known ? '' : '（未在 arena.avatarFrames 配置，显示名回落键名）'}` };
    } catch (err: any) {
      this.logger.warn(`发放头像框失败（玩家 ${uid} / ${key}）: ${err?.message ?? err}`);
      return { ok: false, text: '头像框发放失败' };
    }
  }

  /**
   * 佩戴头像框（同玩家同时只有一个）；传空串=卸下全部。
   * 未拥有时拒绝，避免后台配置一改就能白嫖稀有装扮。
   */
  async equipFrame(userId: number, frameKey: string): Promise<GrantResult> {
    const uid = Number(userId);
    const key = String(frameKey || '').trim();
    if (!Number.isFinite(uid) || uid <= 0) return { ok: false, text: '玩家不存在' };
    if (!key) {
      await this.prisma.playerAvatarFrame.updateMany({ where: { userId: uid, equipped: true }, data: { equipped: false } });
      return { ok: true, text: '已卸下头像框' };
    }
    const owned = await this.prisma.playerAvatarFrame.findUnique({
      where: { userId_frameKey: { userId: uid, frameKey: key } },
    });
    if (!owned) {
      const def = await this.frameDef(key);
      return { ok: false, text: `尚未获得头像框「${def.name}」` };
    }
    await this.prisma.playerAvatarFrame.updateMany({ where: { userId: uid, equipped: true }, data: { equipped: false } });
    await this.prisma.playerAvatarFrame.update({ where: { id: owned.id }, data: { equipped: true } });
    return { ok: true, text: `已佩戴头像框「${owned.name || key}」` };
  }

  /** 玩家头像框列表（拥有 + 定义，供面板与「头像框」指令输出） */
  async listFrames(userId: number): Promise<{ owned: Array<ArenaAvatarFrameDef & { equipped: boolean; source: string }>; equipped: string | null }> {
    const rows = await this.prisma.playerAvatarFrame.findMany({
      where: { userId: Number(userId) },
      orderBy: { ownedAt: 'asc' },
    }).catch(() => [] as any[]);
    const defs = await this.frameDefs();
    const owned = (rows || []).map((r: any) => {
      const def = defs.find((d) => d.key === r.frameKey);
      return {
        key: r.frameKey,
        name: r.name || def?.name || r.frameKey,
        tone: r.tone || def?.tone || '',
        description: def?.description ?? '',
        equipped: !!r.equipped,
        source: r.source ?? '',
      };
    });
    const equipped = owned.find((o) => o.equipped)?.key ?? null;
    return { owned, equipped };
  }

  /** 玩家当前佩戴的头像框（消息负载/榜单展示取一次即可） */
  async equippedFrame(userId: number): Promise<ArenaAvatarFrameDef | null> {
    const row = await this.prisma.playerAvatarFrame.findFirst({
      where: { userId: Number(userId), equipped: true },
    }).catch(() => null);
    if (!row) return null;
    const def = await this.frameDef(row.frameKey);
    return { ...def, name: row.name || def.name, tone: row.tone || def.tone };
  }
}
