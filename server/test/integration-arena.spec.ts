/**
 * 使魔竞技场端到端实机回归（真实远程 MySQL → smdztest）
 *
 * 单测已经把规则钉死，这里验的是「接上真库和真指令通道后整条链还成立」：
 *  ① 走 CommandService 发与 QQ 端逐字相同的指令：竞技场 / 提交镜像 / 挑战镜像 / 战报 / 竞技场管理；
 *  ② 镜像快照真的落库（属性块非空、武器在手），战斗真的跑完整场并写出战报；
 *  ③ 排名互换制真的生效：只能一顺位往上打，打赢换席位、打输与平局都不动；
 *     打排名不高于自己的是**练手局**（免费、不占次数、席位与胜败都不动，只落一份带 practice 标记的战报，
 *     并照样吃防连打冷却）；
 *     并且**打镜像不动真实资产**：逐列比对玩家行，只允许活力按入场消耗变化；
 *  ④ 赛季结算真的按 arena.seasonRewards 发奖，冠军的 batchGather 特权真的能打开采集口
 *     （特权 → resolveBatchCap 生效 → 撤销后立刻失效）。
 *
 * 收尾把本次造的数据全部删干净，测试库回到「竞技场未上线」状态。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CommandService } from '../src/modules/command/command.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandContext, CommandSource } from '../src/modules/command/interfaces/command.interface';
import { GatherPanelService } from '../src/modules/game/commands/gather-panel.service';
import { EntitlementService } from '../src/modules/game/entitlement.service';
import { ArenaService } from '../src/modules/game/arena/arena.service';
import { PRIVILEGE_BATCH_GATHER } from '../src/config/arena.config';

jest.setTimeout(300000);

/**
 * 玩家行里允许因「打一场竞技场」而变化的列。
 * 刻意不包含 markers/markers2/backpack/exp 等：竞技场只该扣掉入场活力，
 * 其余任何一列变了（包括看起来无害的标记位）都说明结算器污染了真实玩家数据。
 */
const ALLOWED_CHANGES = new Set(['vitality', 'version', 'updatedAt', 'lastOpTime', 'readTime']);

/** 玩家行按列比对：BigInt 转字符串（Jest 深比较对 BigInt 键不友好），其余原样 */
function rowForCompare(row: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (ALLOWED_CHANGES.has(key)) continue;
    out[key] = typeof value === 'bigint' ? String(value) : value;
  }
  return out;
}

describe('竞技场端到端（真实库 + 真指令通道）', () => {
  let app: any;
  let prisma: PrismaService;
  let commands: CommandService;
  let gather: GatherPanelService;
  let entitlement: EntitlementService;
  let arena: ArenaService;
  const createdUserIds: number[] = [];
  let ladderWasEmpty = false;
  const stamp = () => Math.random().toString(36).slice(2, 8);

  async function newPlayer(tag: string, overrides: any = {}) {
    const user = await prisma.user.create({
      data: { username: `e2e_arena_${tag}_${stamp()}`, password: 'e2e_test', role: overrides.role || 'USER' },
    });
    createdUserIds.push(user.id);
    const name = `竞技测试${tag}${stamp()}`;
    await prisma.player.create({
      data: {
        userId: user.id,
        name,
        baseName: name,
        type: 'saber',
        specialSeq: 4,
        level: 120,
        exp: 1000,
        // 活力正好取上限（cap=100+魅力，基础 100）：起手上限之内的数最干净，
        // 免得「每条指令都做的每日结算把超上限的活力夹回来」被误读成竞技场在扣资产。
        vitality: 100,
        hp: 800, maxHp: 800, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        attack: 60, defense: 10, speed: 100, dodge: 5, hit: 120, crit: 10, critDmg: 150,
        mapId: 1,
        currentWeapon: 1,
        weapons: [{ name: '自动步枪', type: '射弹武器', damage: 30, data: 'e', bonus: {} }],
        equipment: [],
        markers: {},
        markers2: [],
        buffs: [],
        backpack: [],
        titles: [],
        sets: {},
      } as any,
    });
    return { userId: user.id, name };
  }

  async function send(userId: number, raw: string): Promise<string> {
    const ctx: CommandContext = { userId, channelId: 0, source: CommandSource.WEB, rawMessage: raw };
    const result = await commands.dispatch(ctx);
    return result?.content || '';
  }

  /**
   * 带重试的发送。
   *
   * 本库同时被开发服务进程（`nest start --watch`，同一套定时器会写玩家行）使用，
   * 玩家行是乐观锁 CAS，偶发「玩家数据并发冲突，请重试」是既有的正常语义，
   * 不是竞技场的问题；测试按游戏给玩家的建议重试，而不是把一次竞态当红灯。
   */
  async function sendRetry(userId: number, raw: string, attempts = 8): Promise<string> {
    let last = '';
    for (let i = 0; i < attempts; i++) {
      last = await send(userId, raw);
      if (!last.includes('并发冲突')) return last;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    return last;
  }

  function playerRow(row: any) {
    return prisma.player.findUnique({ where: { userId: row.userId } });
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    commands = app.get(CommandService);
    gather = app.get(GatherPanelService);
    entitlement = app.get(EntitlementService);
    arena = app.get(ArenaService);
    // 「初排」会为全服达标玩家建档，跑之前表是空的就要在收尾整体还原，
    // 否则测试库会留下几百行种子档案，下一次再跑初排就永远是「跳过」。
    ladderWasEmpty = (await prisma.arenaProfile.count()) === 0;
  });

  afterAll(async () => {
    if (prisma) {
      const userIds = createdUserIds.slice();
      await prisma.arenaMatch.deleteMany({ where: { OR: [{ attackerId: { in: userIds } }, { defenderId: { in: userIds } }] } }).catch(() => undefined);
      await prisma.arenaMirror.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => undefined);
      await prisma.arenaProfile.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
      await prisma.playerPrivilege.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
      await prisma.playerAvatarFrame.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
      // 赛季表是全局单例：清掉本次结算产生的公告与赛季行，测试库回到「竞技场未上线」
      await prisma.chatMessage.deleteMany({ where: { content: { contains: '赛季落幕' } } }).catch(() => undefined);
      await prisma.arenaSeason.deleteMany({}).catch(() => undefined);
      if (ladderWasEmpty) {
        // 本次跑之前天梯是空的：初排给全服建的档也一并还原（赛季行已删，留着就是孤儿）
        await prisma.arenaProfile.deleteMany({}).catch(() => undefined);
        await prisma.arenaMirror.deleteMany({}).catch(() => undefined);
      }
      for (const uid of userIds) {
        await prisma.user.delete({ where: { id: uid } }).catch(() => undefined);
      }
    }
    if (app) await app.close();
  });

  it('提交镜像 → 挑战 → 战报 → 赛季结算 → 特权真的打开采集口', async () => {
    const a = await newPlayer('a');
    const b = await newPlayer('b');
    const outsider = await newPlayer('c');
    const admin = await newPlayer('admin', { role: 'SUPER_ADMIN' });

    /** 榜单以镜像为准；初始名次可能改变「谁在前」，所以全程按实际席位取序，不写死提交顺序 */
    const ladderOrder = async (season: number) => prisma.arenaMirror.findMany({
      where: { seasonId: season }, orderBy: [{ rating: 'desc' }, { id: 'asc' }],
    });

    // ① 面板可用（此时还没有镜像，应给出「未提交」提示而不是报错）
    const panel = await send(a.userId, '竞技场');
    expect(panel).toContain('使魔竞技场');
    expect(panel).toContain('尚未提交');

    // ①b 开榜初始名次：系统刚上线（档案表为空）时按当前战力排一次，而不是等谁手快提交镜像
    const seedText = await sendRetry(admin.userId, '竞技场管理 初排');
    expect(seedText).toMatch(/初始排名完成|已有 \d+ 份天梯档案/);
    // 幂等：第二次只会跳过，不会把已经排好的名次重排一遍
    expect(await sendRetry(admin.userId, '竞技场管理 初排')).toMatch(/跳过初始排名|已关闭|暂未开放/);

    // ② 提交镜像：快照真的落库且属性块非空
    const submitText = await sendRetry(a.userId, '提交镜像');
    expect(submitText).toContain('角斗镜像已提交');
    expect(submitText).toContain('生命');
    await sendRetry(b.userId, '提交镜像');
    const mirrorA = await prisma.arenaMirror.findFirst({ where: { ownerId: a.userId } });
    expect(mirrorA).toBeTruthy();
    const seasonId = Number(mirrorA!.seasonId);
    const snap = mirrorA!.snapshot as any;
    expect(Number(snap.bonus?.生命) || 0).toBeGreaterThan(0);
    expect(Array.isArray(snap.weapons) && snap.weapons.length).toBe(1);

    // 没镜像的人不能挑战（保证榜上都是实靶子）
    expect(await send(outsider.userId, `挑战镜像 ${b.name}`)).toContain('还没有角斗镜像');

    // ③ 挑战：只能打排在自己前面的人，且默认只能一顺位往上打
    const first = (await ladderOrder(seasonId))[0];
    const second = (await ladderOrder(seasonId))[1];
    expect(first.ownerId).not.toBe(second.ownerId);
    // ③ 练手局：排前面的人打后面的人不再被拒，但这一场动不了任何人的名次
    const topUser = { userId: Number(first.ownerId) };
    const lowUser = { userId: Number(second.ownerId) };
    const seatTopBefore = Number(first.rating);
    const seatLowBefore = Number(second.rating);
    const vitalityTopBefore = Number((await playerRow(topUser))!.vitality);
    const practiceText = await sendRetry(Number(first.ownerId), `挑战镜像 ${second.ownerName}`);
    expect(practiceText).toContain('练手');
    const seatTopAfterPractice = Number((await prisma.arenaProfile.findUnique({ where: { userId: topUser.userId } }))!.rating);
    const seatLowAfterPractice = Number((await prisma.arenaProfile.findUnique({ where: { userId: lowUser.userId } }))!.rating);
    expect(seatTopAfterPractice).toBe(seatTopBefore);
    expect(seatLowAfterPractice).toBe(seatLowBefore);
    // 免费：不扣活力（游戏自身的时间结算只会回活力，不会扣，所以判「不少于打之前」）
    expect(Number((await playerRow(topUser))!.vitality)).toBeGreaterThanOrEqual(vitalityTopBefore);
    // 双方都不计胜败场次（练手刷不出胜率，也刷不出赛季参与奖的场次）
    const both = await prisma.arenaProfile.findMany({ where: { userId: { in: [topUser.userId, lowUser.userId] } } });
    expect(both.reduce((sum, p) => sum + Number(p.wins) + Number(p.losses) + Number(p.draws), 0)).toBe(0);
    // 但战报确实落库，并且带 practice 标记（审计上能和正式局分开）
    const practiceMatch = await prisma.arenaMatch.findFirst({ where: { attackerId: topUser.userId }, orderBy: { id: 'desc' } });
    expect(practiceMatch).toBeTruthy();
    expect((practiceMatch!.report as any).mode).toBe('practice');
    expect((practiceMatch!.entryCost as any).mode).toBe('practice');
    // 练手局照样吃防连打冷却：免费的东西靠冷却防止被拿来刷同一个人
    expect(await sendRetry(topUser.userId, `挑战镜像 ${second.ownerName}`)).toContain('后才能再挑战');

    // 正式局：第 2 名的镜像打第 1 名（一顺位往上打）——练手局没有动过席位，这里仍是排座次的唯一动作
    const beforeTop = await prisma.player.findUnique({ where: { userId: topUser.userId } });
    const beforeLow = await prisma.player.findUnique({ where: { userId: lowUser.userId } });
    const seatTop0 = seatTopBefore;
    const seatLow0 = seatLowBefore;
    const challengeText = await sendRetry(Number(second.ownerId), `挑战镜像 ${first.ownerName}`);
    expect(challengeText).toMatch(/挑战成功|挑战失败|平局/);
    expect(challengeText).toContain('打的是镜像');
    const match = await prisma.arenaMatch.findFirst({ where: { attackerId: Number(second.ownerId) }, orderBy: { id: 'desc' } });
    expect(match).toBeTruthy();
    const report = match!.report as any;
    expect(Array.isArray(report.lines) && report.lines.length).toBeGreaterThan(3);
    expect(Array.isArray(report.actionLog) && report.actionLog.length).toBeGreaterThan(0);
    expect(report.actionLog.some((line: any) => line.hit && line.damage > 0)).toBe(true);
    expect(['attacker', 'defender', 'draw']).toContain(match!.winner);

    const profileTop = await prisma.arenaProfile.findUnique({ where: { userId: Number(first.ownerId) } });
    const profileLow = await prisma.arenaProfile.findUnique({ where: { userId: Number(second.ownerId) } });
    const seatTop1 = Number(profileTop!.rating);
    const seatLow1 = Number(profileLow!.rating);
    expect(Number(profileLow!.wins) + Number(profileLow!.losses) + Number(profileLow!.draws)).toBe(1);
    // 唯一的记分动作就是席位互换：打赢互换、打输与平局都不动，任何情况下两人的席位集合不变
    if (match!.winner === 'attacker') {
      expect(seatLow1).toBe(seatTop0);
      expect(seatTop1).toBe(seatLow0);
      expect(challengeText).toContain('名次：第 2 名 → 第 1 名');
    } else {
      expect(seatLow1).toBe(seatLow0);
      expect(seatTop1).toBe(seatTop0);
      expect(challengeText).toContain('名次不变');
    }
    expect(new Set([seatTop1, seatLow1])).toEqual(new Set([seatTop0, seatLow0]));
    // 榜分冗余列跟着主人走（攻方也要跟，否则打赢了榜上不动）
    const mirrorLow = await prisma.arenaMirror.findFirst({ where: { ownerId: Number(second.ownerId) } });
    expect(Number(mirrorLow!.rating)).toBe(seatLow1);

    // 防连打：同一镜像短期内不能再打，且被拒的这一次不许扣资产
    // （活力会随时间自然回复，所以判据是「没有被扣掉一次入场费」而不是「一分不差」）
    const vitalityBeforeReject = Number((await playerRow(lowUser))!.vitality);
    expect(await sendRetry(Number(second.ownerId), `挑战镜像 ${first.ownerName}`)).toContain('后才能再挑战');
    expect(Number((await playerRow(lowUser))!.vitality)).toBeGreaterThanOrEqual(vitalityBeforeReject);

    const afterTop = await playerRow(topUser);
    const afterLow = await playerRow(lowUser);
    // 挑战入场费 20（±1 的浮动来自游戏自带的「每条消息做一次时间结算」，与竞技场无关）
    const spentLow = Number(beforeLow!.vitality) - Number(afterLow!.vitality);
    expect(spentLow).toBeGreaterThan(19);
    expect(spentLow).toBeLessThanOrEqual(21);
    const spentTop = Number(beforeTop!.vitality) - Number(afterTop!.vitality);
    expect(spentTop).toBeLessThanOrEqual(1);

    // ③b 把「竞技场自己写了什么」与「游戏每条消息例行的时间结算改了什么」分开：
    // 第三人垫在榜尾，直接调服务让他打**排在他前面那一名**（默认窗口只允许一顺位），
    // 然后逐列比对玩家行 —— 攻方只许掉 20 点活力，守方整行一字不改。
    await arena.submitMirror(outsider.userId);
    const afterThird = await ladderOrder(seasonId);
    const myIndex = afterThird.findIndex((m: any) => Number(m.ownerId) === Number(outsider.userId));
    expect(myIndex).toBeGreaterThan(0);
    const target = afterThird[myIndex - 1];
    expect(myIndex).toBe(2); // 第三人垫在最后（第 3 名），守方就是第 2 名——差 1，符合默认窗口
    const cBefore = await playerRow(outsider);
    const tBefore = await prisma.player.findUnique({ where: { userId: Number(target.ownerId) } });
    expect(await arena.challengeMirror(outsider.userId, String(target.ownerName))).toMatch(/挑战成功|挑战失败|平局/);
    const cAfter = await playerRow(outsider);
    const tAfter = await prisma.player.findUnique({ where: { userId: Number(target.ownerId) } });
    expect(Number(cAfter!.vitality)).toBe(Number(cBefore!.vitality) - 20);
    expect(rowForCompare(cAfter)).toEqual(rowForCompare(cBefore));
    expect(Number(tAfter!.vitality)).toBe(Number(tBefore!.vitality));
    expect(rowForCompare(tAfter)).toEqual(rowForCompare(tBefore));

    // 战报只有参战双方能看
    const reportText = await send(a.userId, `战报 ${match!.id}`);
    expect(reportText).toContain('战报');
    expect(await send(outsider.userId, `战报 ${match!.id}`)).toContain('不属于你');

    // ④ 赛季结算：把本赛季改成已到期，走管理员指令结算
    await prisma.arenaSeason.update({ where: { id: seasonId }, data: { endAt: new Date(Date.now() - 1000) } });
    const settleText = await sendRetry(admin.userId, '竞技场管理 结算');
    expect(settleText).toContain('赛季结算完成');

    const ranked = await prisma.arenaMirror.findMany({ where: { seasonId }, orderBy: { rating: 'desc' } });
    const championId = Number(ranked[0].ownerId);
    const champion = await prisma.player.findUnique({ where: { userId: championId } });
    // 冠军拿到限定称号 + 限定头像框 + batchGather 特权（默认配置：30 天）
    const titles = (champion!.titles as any[]) || [];
    expect(titles.some((t: any) => (typeof t === 'string' ? t : t.name) === '竞技场之王')).toBe(true);
    expect((champion!.markers as any)?.['竞技场赛季冠军']).toBe(1);
    const frame = await prisma.playerAvatarFrame.findFirst({ where: { userId: championId } });
    expect(frame?.frameKey).toBe('arena_champion');
    const privilege = await entitlement.activePrivilege(championId, PRIVILEGE_BATCH_GATHER);
    expect(privilege).toBeTruthy();
    expect(Number(privilege!.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400000);

    // 特权真的把「野外批量采集」从角色判定里解出来：
    // 非家园、非管理员，请求 50 倍 → 被 arena.batchGatherPrivilegeMax（默认 10）截断
    const capped = await (gather as any).resolveBatchCap(championId, false, false, 50);
    expect(capped).toBe(10);
    const loserId = Number(ranked[ranked.length - 1].ownerId);
    expect(await (gather as any).resolveBatchCap(loserId, false, false, 50)).toBe(0);
    // 撤销后立刻失效（读侧判权，不依赖清理任务）
    await entitlement.revokePrivilege(championId, PRIVILEGE_BATCH_GATHER);
    expect(await (gather as any).resolveBatchCap(championId, false, false, 50)).toBe(0);

    // 结算幂等：再点一次结算不会有第二个赛季、也不会重复发奖
    const matchesBefore = await prisma.arenaMatch.count({ where: { seasonId } });
    expect(await sendRetry(admin.userId, '竞技场管理 结算')).toContain('没有到期的赛季');
    expect(await prisma.arenaMatch.count({ where: { seasonId } })).toBe(matchesBefore);
  });
});
