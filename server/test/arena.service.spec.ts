/**
 * 竞技场天梯业务单测（内存假库，不连 MySQL）。
 *
 * 覆盖的是**排名互换制**的规则本身：
 * 席位怎么发、谁能打谁、打赢换位 / 打输不动、段位跟着名次重算、
 * 每日次数与入场消耗（活力 / 门票）、防连打、战报可见性、引擎异常退款，
 * 以及最要紧的一条——**打镜像不动任何真实资产**（只有入场消耗会动活力）。
 * 伤害数值不在这里验（见 arena-battle.spec.ts）。
 */
import { ArenaService } from '../src/modules/game/arena/arena.service';
import { arenaTodayString } from '../src/config/arena.config';

/** 与 world-event.spec.ts 同一手法：按模型建内存表 + 最小 where/orderBy/skip/take 语义 */
function makeFakePrisma() {
  const tables: Record<string, any[]> = {
    arenaSeason: [], arenaProfile: [], arenaMirror: [], arenaMatch: [],
    user: [{ id: 1, role: 'SUPER_ADMIN' }, { id: 2, role: 'USER' }, { id: 3, role: 'USER' }],
    player: [],
  };
  let nextId = 1;
  const idOf = () => nextId++;
  /**
   * schema 里这些列带 @default，真库 create 不传也会填上；假库必须照做，
   * 否则「没传字段」在测试里是 undefined、在库里是 0，断言会算出 NaN 或漏掉真实行为。
   */
  const MODEL_DEFAULTS: Record<string, any> = {
    arenaSeason: { name: '', status: 'ACTIVE' },
    arenaProfile: { seasonId: 0, rating: 1, bestRank: 0, tier: '', wins: 0, losses: 0, draws: 0, streak: 0, mirrorPower: 0, mirrorLevel: 0 },
    arenaMirror: { ownerName: '', seasonId: 0, power: 0, level: 0, rating: 1, tier: '', version: 1 },
    arenaMatch: { seasonId: 0, attackerName: '', defenderName: '', mirrorVersion: 1, winner: '', rounds: 0, durationSec: 0, attackerRatingBefore: 0, attackerRatingAfter: 0, defenderRatingBefore: 0, defenderRatingAfter: 0 },
  };
  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as any[]).some((sub) => matches(row, sub))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!(cond as any[]).every((sub) => matches(row, sub))) return false;
        continue;
      }
      const value = row[key];
      if (key === 'NOT') {
        // Prisma 的 NOT 子句：命中条件的人要被排除
        if (matches(row, cond)) return false;
        continue;
      }
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as any;
        if ('in' in c && !c.in.includes(value)) return false;
        if ('gt' in c && !(Number(value) > Number(c.gt))) return false;
        if ('gte' in c && !(Number(value) >= Number(c.gte))) return false;
        if ('lt' in c && !(Number(value) < Number(c.lt))) return false;
        if ('lte' in c && !(new Date(value).getTime() <= Number(c.lte))) return false;
        // 榜单按主人名模糊搜索用的 contains
        if ('contains' in c && !String(value ?? '').includes(String(c.contains))) return false;
        if (!('in' in c || 'gt' in c || 'gte' in c || 'lt' in c || 'lte' in c || 'contains' in c)) {
          for (const [subKey, subVal] of Object.entries(c)) {
            if (row[subKey] !== subVal) return false;
          }
        }
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };
  const applyOrder = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
    return rows.sort((a, b) => {
      for (const entry of keys) {
        for (const [field, dir] of Object.entries(entry as any)) {
          const av = a[field];
          const bv = b[field];
          const cmp = typeof av === 'number' ? av - Number(bv) : String(av).localeCompare(String(bv));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
      }
      return 0;
    });
  };
  const model = (name: string) => ({
    findMany: jest.fn(async ({ where, orderBy, skip, take }: any = {}) => {
      let rows = tables[name].filter((row) => matches(row, where)).map((row) => ({ ...row }));
      rows = applyOrder(rows, orderBy);
      if (skip) rows = rows.slice(skip);
      if (take) rows = rows.slice(0, take);
      return rows;
    }),
    findFirst: jest.fn(async ({ where, orderBy }: any = {}) => {
      let rows = tables[name].filter((row) => matches(row, where)).map((row) => ({ ...row }));
      rows = applyOrder(rows, orderBy);
      return rows[0] ?? null;
    }),
    findUnique: jest.fn(async ({ where }: any = {}) => {
      const rows = tables[name].filter((row) => matches(row, where));
      return rows[0] ? { ...rows[0] } : null;
    }),
    count: jest.fn(async ({ where }: any = {}) => tables[name].filter((row) => matches(row, where)).length),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: idOf(), createdAt: new Date(), updatedAt: new Date(), ...(MODEL_DEFAULTS[name] || {}), ...data };
      tables[name].push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = tables[name].find((r) => matches(r, where));
      if (!row) throw new Error('P2025 no record found');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = tables[name].filter((r) => matches(r, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const keep = tables[name].filter((r) => !matches(r, where));
      const removed = tables[name].length - keep.length;
      tables[name] = keep;
      return { count: removed };
    }),
  });
  const prismaRef: any = {
    arenaSeason: model('arenaSeason'),
    arenaProfile: model('arenaProfile'),
    arenaMirror: model('arenaMirror'),
    arenaMatch: model('arenaMatch'),
    user: model('user'),
    player: model('player'),
    __tables: tables,
  };
  return prismaRef;
}

function makePlayerRow(userId: number, over: any = {}) {
  return {
    id: userId, userId, level: 120, name: `玩家${userId}`, baseName: `玩家${userId}`, type: 'saber',
    specialSeq: 4, currentWeapon: 1, vitality: 100, exp: 5000, hp: 800, maxHp: 800,
    shield: 0, armor: 0, backpack: [], equipment: [], weapons: [{ name: '铁剑', damage: 10, data: 'e' }],
    markers: {}, markers2: [], buffs: [], sets: {}, titles: [],
    // 真库这三列是 BigInt：快照构造若用裸 JSON 深拷贝会直接抛「无法序列化 BigInt」
    lastOpTime: BigInt(0), readTime: BigInt(0), playTime: BigInt(123),
    ...over,
  };
}

function ctxOf(playerRow: any) {
  return {
    player: playerRow,
    backpack: playerRow.backpack,
    equipment: playerRow.equipment,
    weapons: playerRow.weapons,
    markers: playerRow.markers,
    markers2: playerRow.markers2,
    buffs: playerRow.buffs,
    tasks: [],
    safeBox: [],
    sets: playerRow.sets,
  };
}

function makeService(options: {
  /** 返回 'attacker' / 'defender' / 'draw'，或抛错模拟引擎故障 */
  winner?: 'attacker' | 'defender' | 'draw' | 'rotate';
  fight?: any;
  configOverrides?: Record<string, any>;
  players?: Record<number, any>;
  /** 逐人指定战斗力（初始排名用例要的是「不同人不同战力」，默认所有桩都是同一个数） */
  powers?: Record<number, number>;
} = {}) {
  const prisma = makeFakePrisma();
  const players: Record<number, any> = {
    1: makePlayerRow(1),
    2: makePlayerRow(2, { level: 118 }),
    3: makePlayerRow(3, { level: 5 }),
    ...(options.players || {}),
  };
  const overrides = options.configOverrides || {};
  const systemConfig = {
    get: jest.fn(async (key: string, defaultValue: any) => (key in overrides ? overrides[key] : defaultValue)),
    getMany: jest.fn(async () => overrides),
  };
  const mutate = {
    read: jest.fn(async (userId: number, fn: any) => fn(ctxOf(players[userId]))),
    mutate: jest.fn(async (userId: number, fn: any) => fn(ctxOf(players[userId]))),
  };
  const bonusService = {
    calcCombatPower: jest.fn((bonus: any) => (options.powers ? Number(bonus?.__power) || 0 : 4321)),
  };
  let battleCalls = 0;
  const battle = {
    fight: jest.fn(options.fight || ((attacker: any, defender: any) => ({
      // 'rotate'：按调用顺序轮流判攻方胜 / 守方胜 / 平，便于在一条用例里连打多场
      winner: options.winner === 'rotate' ? (['attacker', 'defender', 'draw'][battleCalls++ % 3] as any) : (options.winner || 'attacker'),
      reason: 'ko', actions: 6, durationSec: 25,
      lines: [`战报：${attacker.name} 对 ${defender.name}`], actionLog: [],
      sides: { attacker: {}, defender: {} },
    }))),
  };
  const entitlement = {
    equippedFrame: jest.fn(async () => null),
    equipFrame: jest.fn(async (_uid: number, _key: string) => ({ ok: true, text: '' })),
    listFrames: jest.fn(async () => ({ owned: [], equipped: null })),
    listActivePrivileges: jest.fn(async () => []),
  };
  const playerService = { addToBackpack: jest.fn(async () => undefined) };
  const combat = {
    buildAttackerBonus: jest.fn((player: any) => ({
      攻击: 200, 命中: 120, 闪避: 20, 暴击: 10, 生命: 3000, 装甲: 500, 护盾: 800,
      // 只有传了 powers 的用例走「逐人不同战力」这条路（初始名次排序要的是这个），其余测试仍是恒定 4321
      __power: options.powers ? Number(options.powers[Number(player?.userId)]) || 0 : 0,
    })),
  };
  const service = new ArenaService(
    prisma, systemConfig as any, mutate as any, bonusService as any, battle as any, entitlement as any,
    combat as any, playerService as any,
  );
  // 初始排名走的是「扫全服玩家表」那条路（不是 mutate 上下文），所以桩要把行也灌进表里
  prisma.__tables.player.push(...Object.values(players));
  return { service, prisma, players, systemConfig, mutate, battle, entitlement, combat, playerService };
}

/** 席位号只是排序键：按提交先后 0 / -1 / -2 往后排，先提交的人名次在前 */
function seatsOf(prisma: any): Record<number, number> {
  return Object.fromEntries(prisma.__tables.arenaProfile.map((p: any) => [p.userId, p.rating]));
}

describe('ArenaService · 镜像提交与席位', () => {
  it('首次进入自动开赛季，提交镜像即上榜并拿到最后一个席位之后的位置', async () => {
    const { service, prisma } = makeService();
    const text = await service.submitMirror(1);
    expect(text).toContain('角斗镜像已提交');
    expect(text).toContain('战斗力 4321');
    expect(text).toContain('当前第 1 名');
    const seasons = prisma.__tables.arenaSeason;
    expect(seasons).toHaveLength(1);
    expect(seasons[0].status).toBe('ACTIVE');
    const mirrors = prisma.__tables.arenaMirror;
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].ownerId).toBe(1);
    expect(mirrors[0].snapshot.bonus.生命).toBe(3000);
    const profile = prisma.__tables.arenaProfile.find((p: any) => p.userId === 1);
    expect(profile.mirrorId).toBe(mirrors[0].id);
    expect(profile.rating).toBe(1);
    // 席位只是排序键（空榜第一人拿 1 号位，之后依次往后）。
    // 一上榜就是第 1 名，不打仗也算「达到过的最好名次」。
    expect(profile.bestRank).toBe(1);
  });

  it('新入榜者一律插到最后一名之后（没有初始分可发）', async () => {
    const { service, prisma } = makeService({ players: { 4: makePlayerRow(4) } });
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.submitMirror(4);
    expect(seatsOf(prisma)).toEqual({ 1: 1, 2: 0, 4: -1 });
    const rows = await service.ladderRows(1, 1, 20);
    expect(rows.rows.map((r) => r.ownerId)).toEqual([1, 2, 4]);
    expect(rows.rows.map((r) => r.seat)).toEqual([1, 0, -1]);
    // 段位按名次给，不是按分数阈值
    expect(rows.rows[0].tier).toBe('传奇角斗士');
    expect(rows.rows[1].tier).toBe('天梯大师');
    expect(rows.rows[2].tier).toBe('天梯大师');
  });

  it('再次提交是覆盖刷新（版本 +1，席位与名次不变）', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    const before = seatsOf(prisma);
    const text = await service.submitMirror(2);
    expect(text).toContain('镜像已刷新（第 2 版）');
    expect(prisma.__tables.arenaMirror.filter((m: any) => m.ownerId === 2)).toHaveLength(1);
    expect(prisma.__tables.arenaMirror.find((m: any) => m.ownerId === 2).version).toBe(2);
    expect(seatsOf(prisma)).toEqual(before);
  });

  it('低于开放等级不能提交', async () => {
    // 玩家 3 是 Lv.5 的小号，默认开放等级 30 应把它拦在门外
    const { service, prisma } = makeService();
    const text = await service.submitMirror(3);
    expect(text).toContain('竞技场在 Lv.30 开放');
    expect(prisma.__tables.arenaMirror).toHaveLength(0);
  });

  it('面板报名次与剩余次数，不报积分', async () => {
    const { service } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    const panel = await service.viewPanel(2, '');
    expect(panel).toContain('我的名次：第 2 名');
    expect(panel).toContain('只能挑战紧挨在你前面的那一个镜像');
    expect(panel).toContain('一顺位往上打');
    expect(panel).toContain('今日挑战：剩 10/10 次');
    expect(panel).not.toContain('分 ·');
  });
});

describe('ArenaService · 排名互换', () => {
  it('打赢：顶替对手席位，对手退到自己的旧位置，双方镜像与段位同步', async () => {
    const { service, prisma, players } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    // 2 在第 2 名之后，只能打第 1 名的 1
    const text = await service.challengeMirror(2, '玩家1');
    expect(text).toContain('挑战成功');
    expect(text).toContain('名次：第 2 名 → 第 1 名');
    expect(text).toContain('对手：第 1 名 → 第 2 名');
    // 席位互换
    expect(seatsOf(prisma)).toEqual({ 1: 0, 2: 1 });
    const p1 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 1);
    const p2 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 2);
    expect(p2.wins).toBe(1);
    expect(p2.tier).toBe('传奇角斗士');
    expect(p1.losses).toBe(1);
    expect(p1.tier).toBe('天梯大师');
    expect(p2.bestRank).toBe(1);
    expect(p1.bestRank).toBe(1);
    // 双方镜像行的席位都要跟着主人走（只刷守方会让攻方打赢了却榜上不动）
    expect(prisma.__tables.arenaMirror.find((m: any) => m.ownerId === 2).rating).toBe(1);
    expect(prisma.__tables.arenaMirror.find((m: any) => m.ownerId === 1).rating).toBe(0);
    // 战报落库 + 席位/名次快照写进 report
    const match = prisma.__tables.arenaMatch[0];
    expect(match.winner).toBe('attacker');
    expect(match.attackerRatingBefore).toBe(0);
    expect(match.attackerRatingAfter).toBe(1);
    expect(match.report.seats).toEqual({ attacker: { before: 0, after: 1 }, defender: { before: 1, after: 0 }, swapped: true });
    expect(match.report.ranks).toEqual({ attacker: { before: 2, after: 1 }, defender: { before: 1, after: 2 } });
    // 真实资产只流出入场活力
    expect(players[2].vitality).toBe(100 - 10 - 20);
    expect(players[1].vitality).toBe(100 - 10);
    expect(players[2].exp).toBe(5000);
    expect(players[1].exp).toBe(5000);
    expect(players[1].backpack).toEqual([]);
  });

  it('打输与平局都不动席位（所以没人能靠故意输来喂人）', async () => {
    const lost = makeService({ winner: 'defender' });
    await lost.service.submitMirror(1);
    await lost.service.submitMirror(2);
    const text = await lost.service.challengeMirror(2, '玩家1');
    expect(text).toContain('挑战失败');
    expect(text).toContain('名次不变');
    expect(seatsOf(lost.prisma)).toEqual({ 1: 1, 2: 0 });
    const p2 = lost.prisma.__tables.arenaProfile.find((p: any) => p.userId === 2);
    expect(p2.losses).toBe(1);
    expect(p2.streak).toBe(-1);
    expect(p2.bestRank).toBe(2);
    // 守方赢球不改席位，但段位按名次重算、胜场记账
    const p1 = lost.prisma.__tables.arenaProfile.find((p: any) => p.userId === 1);
    expect(p1.wins).toBe(1);
    expect(p1.rating).toBe(1);

    const drawn = makeService({ winner: 'draw' });
    await drawn.service.submitMirror(1);
    await drawn.service.submitMirror(2);
    const drawText = await drawn.service.challengeMirror(2, '玩家1');
    expect(drawText).toContain('平局');
    expect(seatsOf(drawn.prisma)).toEqual({ 1: 1, 2: 0 });
    expect(drawn.prisma.__tables.arenaProfile.find((p: any) => p.userId === 2).draws).toBe(1);
  });

  it('跳级打不到：被拒的这次不计费、不计次、不写战报', async () => {
    const { service, prisma, players } = makeService({ players: { 4: makePlayerRow(4) } });
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.submitMirror(4);
    const before = seatsOf(prisma);
    // 4 在第 3 名，默认窗口 1 → 第 1 名的 1 打不到
    const text = await service.challengeMirror(4, '玩家1');
    expect(text).toContain('只能一顺位往上打');
    expect(seatsOf(prisma)).toEqual(before);
    expect(prisma.__tables.arenaMatch).toHaveLength(0);
    // 被拒的这次既不扣次数也不扣活力
    expect(players[4].vitality).toBe(90);
    const p4 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 4);
    expect(Number(p4.daily?.used || 0)).toBe(0);
  });

  it('默认只能一顺位往上打：想碰更高的人必须先赢眼前这个', async () => {
    const { service, prisma, players } = makeService({ players: { 4: makePlayerRow(4) } });
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.submitMirror(4);
    // 4 在第 3 名：第 1 名差 2 → 跳级被拦；第 2 名差 1 → 放行
    expect(await service.challengeMirror(4, '玩家1')).toContain('只能一顺位往上打');
    expect(prisma.__tables.arenaMatch).toHaveLength(0);
    expect(players[4].vitality).toBe(100 - 10); // 被拦的这次不扣入场活力
    expect(await service.challengeMirror(4, '玩家2')).toContain('挑战成功');
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
  });

  it('窗口调成 0 就放开跳级（后台想允许狙击榜首时改这一个值）', async () => {
    const { service } = makeService({
      configOverrides: { 'arena.challengeRankWindow': 0 },
      players: { 4: makePlayerRow(4) },
    });
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.submitMirror(4);
    expect(await service.challengeMirror(4, '玩家1')).toContain('挑战成功');
  });

  it('窗口也能收紧成别的步长（设为 2 时差 3 仍被拦）', async () => {
    const { service, players } = makeService({
      configOverrides: { 'arena.challengeRankWindow': 2 },
      players: { 4: makePlayerRow(4), 5: makePlayerRow(5) },
    });
    for (const uid of [1, 2, 4, 5]) await service.submitMirror(uid);
    // 5 在第 4 名，第 1 名差 3 → 拦下
    expect(await service.challengeMirror(5, '玩家1')).toContain('一次最多能挑战高出 2 名');
    expect(players[5].vitality).toBe(100 - 10);
  });

  it('按榜单序号挑战同样命中目标镜像', async () => {
    const { service } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    expect(await service.challengeMirror(2, '1')).toContain('挑战成功');
  });

  it('自己不在榜上（未提交镜像）时不能挑战别人', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    const text = await service.challengeMirror(3, '玩家1');
    expect(text).toContain('竞技场在 Lv.30 开放');
    expect(prisma.__tables.arenaMatch).toHaveLength(0);
  });

  it('不能挑战自己的镜像', async () => {
    const { service } = makeService();
    await service.submitMirror(1);
    expect(await service.challengeMirror(1, '玩家1')).toContain('不能挑战自己');
  });

  it('同一镜像在防连打窗口内不能连续挑战', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.challengeMirror(2, '玩家1');
    // 换位后 2 已在第 1 名，玩家 1 落到第 2 名 → 这次是「排名不够」，但防连打更早命中不了，
    // 因此换回原靶子：把玩家 1 的席位重新抬高再打，验证防连打文案
    prisma.__tables.arenaProfile.find((p: any) => p.userId === 1).rating = 5;
    prisma.__tables.arenaMirror.find((m: any) => m.ownerId === 1).rating = 5;
    const second = await service.challengeMirror(2, '玩家1');
    expect(second).toContain('后才能再挑战');
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
    expect(prisma.__tables.arenaProfile.find((p: any) => p.userId === 2).daily.used).toBe(1);
  });

  it('每日挑战次数用完后正式局被拒，且不再扣活力', async () => {
    const { service, prisma, players } = makeService({
      configOverrides: { 'arena.dailyChallengeLimit': 1 },
      players: { 4: makePlayerRow(4) },
    });
    await service.submitMirror(1);
    await service.submitMirror(4);
    await service.submitMirror(2);
    // 2（第 3 名）先与 4（第 2 名）打一场正式局，把唯一的次数用掉
    expect(await service.challengeMirror(2, '玩家4')).toContain('挑战');
    const vitalityAfterFirst = players[2].vitality;
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
    // 换一个没打过的目标（第 1 名的 1，与 2 现在正好差 1 名）→ 次数已用完，且不再扣活力
    const text = await service.challengeMirror(2, '玩家1');
    expect(text).toContain('今日挑战次数已用完');
    expect(players[2].vitality).toBe(vitalityAfterFirst);
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
  });

  it('活力不足时直接拒绝，不计次、不写战报', async () => {
    // 提交镜像设为免费，才能把「活力不足」这一步单独隔离出来验证
    const { service, prisma, players } = makeService({
      configOverrides: { 'arena.submitMode': 'free' },
      players: { 1: makePlayerRow(1, { vitality: 5 }), 2: makePlayerRow(2, { vitality: 5 }) },
    });
    await service.submitMirror(1);
    await service.submitMirror(2);
    const text = await service.challengeMirror(2, '玩家1');
    expect(text).toContain('活力不足');
    expect(prisma.__tables.arenaMatch).toHaveLength(0);
    const profile = prisma.__tables.arenaProfile.find((p: any) => p.userId === 2);
    expect(Number(profile?.daily?.used || 0)).toBe(0);
  });

  it('门票模式下按背包道具计费，数量不足直接拒绝', async () => {
    const base = {
      'arena.submitMode': 'free',
      'arena.entryMode': 'ticket', 'arena.entryTicketItem': '竞技场门票', 'arena.entryTicketCost': 2,
    };
    const withTickets = makeService({
      configOverrides: base,
      players: { 1: makePlayerRow(1), 2: makePlayerRow(2, { backpack: [{ name: '竞技场门票', quantity: 3 }] }) },
    });
    await withTickets.service.submitMirror(1);
    await withTickets.service.submitMirror(2);
    expect(await withTickets.service.challengeMirror(2, '玩家1')).toContain('挑战成功');
    expect(withTickets.players[2].backpack[0].quantity).toBe(1);
    expect(withTickets.players[2].vitality).toBe(100);

    const poor = makeService({
      configOverrides: base,
      players: { 1: makePlayerRow(1), 2: makePlayerRow(2, { backpack: [{ name: '竞技场门票', quantity: 1 }] }) },
    });
    await poor.service.submitMirror(1);
    await poor.service.submitMirror(2);
    expect(await poor.service.challengeMirror(2, '玩家1')).toContain('需要「竞技场门票」x2');
    expect(poor.prisma.__tables.arenaMatch).toHaveLength(0);
  });

  it('战斗引擎异常时退还活力，不白吃玩家的入场消耗', async () => {
    const { service, prisma, players } = makeService({
      fight: () => { throw new Error('战斗引擎炸了'); },
    });
    await service.submitMirror(1);
    await service.submitMirror(2);
    expect(await service.challengeMirror(2, '玩家1')).toContain('结算异常');
    // 提交扣 10，挑战扣了又退回来 → 停在 90
    expect(players[2].vitality).toBe(90);
    expect(seatsOf(prisma)).toEqual({ 1: 1, 2: 0 });
    expect(prisma.__tables.arenaMatch).toHaveLength(0);
  });

  it('门票模式的引擎异常走背包出口退还，不手搓野行', async () => {
    const { service, playerService } = makeService({
      configOverrides: {
        'arena.submitMode': 'free',
        'arena.entryMode': 'ticket', 'arena.entryTicketItem': '竞技场门票', 'arena.entryTicketCost': 2,
      },
      players: { 1: makePlayerRow(1), 2: makePlayerRow(2, { backpack: [{ name: '竞技场门票', quantity: 3 }] }) },
      fight: () => { throw new Error('战斗引擎炸了'); },
    });
    await service.submitMirror(1);
    await service.submitMirror(2);
    expect(await service.challengeMirror(2, '玩家1')).toContain('结算异常');
    expect(playerService.addToBackpack).toHaveBeenCalledWith(2, '竞技场门票', 2);
  });

  it('多人同时打同一镜像：两次换位都要记账', async () => {
    const { service, prisma } = makeService({
      players: { 1: makePlayerRow(1), 2: makePlayerRow(2), 4: makePlayerRow(4) },
    });
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.submitMirror(4);
    const results = await Promise.all([
      service.challengeMirror(2, '玩家1'),
      service.challengeMirror(4, '玩家1'),
    ]);
    expect(results.every((text) => text.includes('挑战成功'))).toBe(true);
    const top = prisma.__tables.arenaMirror.find((m: any) => m.ownerId === 1);
    expect(prisma.__tables.arenaMatch).toHaveLength(2);
    // 两条挑战串行：第二条打到的已是换位后的席位，冠军镜像的席位必须等于某一条的旧席位
    expect([0, -1]).toContain(Number(top.rating));
    const p2 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 2);
    const p4 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 4);
    expect(p2.wins + p4.wins).toBe(2);
  });

  it('同一玩家连点两次挑战：每日次数不会被双花', async () => {
    const { service, prisma, players } = makeService({
      configOverrides: { 'arena.dailyChallengeLimit': 1 },
      players: { 4: makePlayerRow(4) },
    });
    await service.submitMirror(1);
    await service.submitMirror(4);
    const results = await Promise.all([
      service.challengeMirror(4, '玩家1'),
      service.challengeMirror(4, '玩家1'),
    ]);
    expect(results.filter((text) => text.includes('挑战成功'))).toHaveLength(1);
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
    const attacker = prisma.__tables.arenaProfile.find((p: any) => p.userId === 4);
    expect(attacker.daily.used).toBe(1);
    expect(players[4].vitality).toBe(100 - 10 - 20);
  });

  /**
   * 名次判定必须在「双方参战锁」内做：排队等锁期间，守方可能已经被别人顶到了自己后面。
   * 这里手工占住参战锁 + 换位复现——判据若在锁外，就会拿着过期名次把它当正式局结算，
   * 4 打赢反而掉到 2 的差席位上；判据在锁内则改判练手局，谁都不动。
   */
  it('排队期间守方掉到自己后面：轮到时按最新名次改判练手局，不误换位', async () => {
    const { service, prisma, players } = makeService({
      players: { 1: makePlayerRow(1), 2: makePlayerRow(2), 4: makePlayerRow(4), 5: makePlayerRow(5) },
    });
    for (const uid of [1, 2, 4, 5]) await service.submitMirror(uid);
    // 席位 1/0/-1/-2 → 名次 1/2/3/4：4 打 2 合法（3 名打 2 名）
    const registry = (service as any).participantLocks as Map<number, Promise<void>>;
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    registry.set(2, held); // 假装 5 正在与 2 结算，把 2 的键占住

    const pending = service.challengeMirror(4, '玩家2');
    await new Promise((res) => setImmediate(res)); // 让 4 走到「排队等锁」这一步

    // 那一场的结果：5 赢了 2，两人席位互换 → 2 退到 4 的后面
    const seatOf = (uid: number) => Number(prisma.__tables.arenaProfile.find((p: any) => p.userId === uid).rating);
    const move = (uid: number, seat: number) => {
      const mirrorId = Number(prisma.__tables.arenaProfile.find((p: any) => p.userId === uid).mirrorId);
      prisma.__tables.arenaMirror.find((m: any) => m.id === mirrorId).rating = seat;
      prisma.__tables.arenaProfile.find((p: any) => p.userId === uid).rating = seat;
    };
    const seat2 = seatOf(2);
    const seat5 = seatOf(5);
    move(5, seat2);
    move(2, seat5);
    release();

    const text = await pending;
    // 名次判定在锁内做，所以轮到自己时看到的是最新名次：4 已在 2 前面 → 这一场判成练手局，
    // 席位与名次一律不动。判据若留在锁外，拿着过期名次会把它当正式局结算，4 打赢反而掉到 2 的差席位。
    expect(text).toContain('练手');
    expect(text).toContain('不计成绩、不动席位');
    expect(seatsOf(prisma)).toEqual({ 1: 1, 2: -2, 4: -1, 5: 0 });
    // 拒绝发生在计费之前：不写战报、不扣活力、不计次
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
    expect(players[4].vitality).toBe(100 - 10);
    const p4 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 4);
    expect(Number(p4.daily?.used || 0)).toBe(0);
    expect(Number(p4.wins)).toBe(0);
  });

  it('战报只有参战双方能看', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.challengeMirror(2, '玩家1');
    const matchId = prisma.__tables.arenaMatch[0].id;
    expect(await service.viewReport(2, matchId)).toContain('战报');
    expect(await service.viewReport(3, matchId)).toContain('不属于你');
  });

  it('「头像框 佩戴 无」是卸下指令，不会被当成框键去查拥有', async () => {
    const { service, entitlement } = makeService();
    const seen: string[] = [];
    entitlement.equipFrame = jest.fn(async (_uid: number, key: string) => {
      seen.push(key || '<空>');
      return { ok: true, text: '已卸下头像框' };
    });
    expect(await service.viewFrames(1, '佩戴 无')).toContain('已卸下');
    expect(await service.viewFrames(1, '佩戴')).toContain('已卸下');
    expect(await service.viewFrames(1, '佩戴 arena_champion')).toContain('已卸下');
    // 第三条给的是真键，必须原样透传（不能被卸下别名逻辑吃掉）
    expect(seen).toEqual(['<空>', '<空>', 'arena_champion']);
  });
});

describe('ArenaService · 只读接口负载（网页天梯页吃这份，不做文本解析）', () => {
  it('战绩把同一场对局从双方视角都给对：胜方席位升、被顶方席位降，都算换过位', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.challengeMirror(2, '玩家1');
    const attackerRows = await service.matchesForUser(2, 1);
    const defenderRows = await service.matchesForUser(1, 1);
    expect(attackerRows.total).toBe(1);
    expect(defenderRows.total).toBe(1);
    const byAttacker = attackerRows.rows[0];
    const byDefender = defenderRows.rows[0];
    expect(byAttacker.id).toBe(byDefender.id);
    expect(byAttacker.attacked).toBe(true);
    expect(byDefender.attacked).toBe(false);
    // 守方是被顶下去的那一个：席位变小，但同样是「换过位」，不能因为只判「升」就报成没动
    expect(byAttacker.swapped).toBe(true);
    expect(byDefender.swapped).toBe(true);
    expect(byAttacker.seatAfter).toBeGreaterThan(byAttacker.seatBefore);
    expect(byDefender.seatAfter).toBeLessThan(byDefender.seatBefore);
  });

  it('概况与战报给名次不给分数', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.challengeMirror(2, '玩家1');
    const overview: any = await service.getOverview(2);
    expect(overview.me.rank).toBe(1);
    expect(overview.me.bestRank).toBe(1);
    expect(overview.me.tier).toBe('传奇角斗士');
    expect(overview.me.challengeRankWindow).toBe(1);
    expect(Object.keys(overview.me).sort()).toEqual([
      'avoidUntil', 'bestRank', 'challengeRankWindow', 'dailyLeft', 'dailyLimit', 'draws', 'losses',
      'mirror', 'rank', 'seat', 'streak', 'tier', 'userId', 'wins',
    ]);
    const report: any = await service.reportForUser(prisma.__tables.arenaMatch[0].id, 2);
    expect(report.ranks).toEqual({ attacker: { before: 2, after: 1 }, defender: { before: 1, after: 2 } });
    expect(report.seats.swapped).toBe(true);
  });

  it('榜单按主人名过滤后，rank 仍是全榜名次（搜索结果里的「挑战镜像 N」不能指向别人）', async () => {
    const { service, prisma } = makeService({ players: { 4: makePlayerRow(4) } });
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.submitMirror(4);
    const seasonId = prisma.__tables.arenaSeason[0].id;

    const full = await service.ladderRows(seasonId, 1, 20);
    expect(full.rows).toHaveLength(3);
    expect(full.search).toBe('');
    const rankOf = new Map(full.rows.map((r) => [r.ownerName, r.rank]));

    const filtered = await service.ladderRows(seasonId, 1, 20, '玩家2');
    expect(filtered.rows.map((r) => r.ownerName)).toEqual(['玩家2']);
    expect(filtered.total).toBe(1);
    expect(filtered.search).toBe('玩家2');
    // 关键：过滤后的名次取自全榜，不是"结果里的第 1 行"
    expect(filtered.rows[0].rank).toBe(rankOf.get('玩家2'));
    expect(filtered.rows[0].rank).not.toBe(1);

    // 搜不到就给空结果，而不是回落成全榜
    const none = await service.ladderRows(seasonId, 1, 20, '不存在的人');
    expect(none.rows).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('概况把防连打冷却摊开：刚打过的镜像带着解冻时刻，网页才标得出「这一位现在打不了」', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.challengeMirror(2, '玩家1');
    const targetMirrorId = prisma.__tables.arenaMirror.find((m: any) => m.ownerId === 1).id;

    // 攻方刚打过 1 号镜像：冷却表里必须有它，且时刻在将来
    const attackerView: any = await service.getOverview(2);
    const until = Number(attackerView.me.avoidUntil[String(targetMirrorId)]) || 0;
    expect(until).toBeGreaterThan(Date.now());
    // 守方没主动打过人：空表，而不是 undefined（前端按 key 取值，不该再判存在性）
    const defenderView: any = await service.getOverview(1);
    expect(defenderView.me.avoidUntil).toEqual({});
  });

  it('侦察某名次镜像：三池/战斗属性/在手武器一次给全，且不替访客建档', async () => {
    const { service, prisma } = makeService();
    await service.submitMirror(1);
    await service.submitMirror(2);
    await service.challengeMirror(2, '玩家1');
    const seasonId = prisma.__tables.arenaSeason[0].id;

    // 2 号打赢后顶到第 1 名，被顶下去的 1 号镜像落在第 2 名——侦察的正是刚打过的那一位
    const intel: any = await service.scoutMirror(2, seasonId, 2);
    expect(intel.found).toBe(true);
    expect(intel.rank).toBe(2);
    expect(intel.ownerName).toBe('玩家1');
    expect(intel.detail.pools).toEqual({ hp: 3000, armor: 500, shield: 800 });
    expect(intel.detail.stats).toEqual({ attack: 200, hit: 120, dodge: 20, crit: 10 });
    expect(intel.detail.weaponName).toBe('铁剑');
    expect(intel.detail.weaponCount).toBe(1);
    // 摘要文本与指令「竞技场 序号」同一份算法，两条入口对同一镜像不能各说一套
    expect(intel.summary.join('\n')).toContain('镜像主人：玩家1');
    // 2 号刚打过 1 号镜像：侦察结果里就该带上冷却时刻，网页据此把这一行标成打不了
    expect(intel.cooldownUntil).toBeGreaterThan(Date.now());

    // 只读纪律：3 号既没档案也没上榜，侦察不能顺手给他建一条
    const idle: any = await service.scoutMirror(3, seasonId, 1);
    expect(idle.cooldownUntil).toBe(0);
    expect(prisma.__tables.arenaProfile.some((p: any) => p.userId === 3)).toBe(false);

    // 榜上没有的名次：给一句人话，不抛错也不回空对象
    const missing: any = await service.scoutMirror(2, seasonId, 99);
    expect(missing.found).toBe(false);
    expect(missing.message).toContain('天梯榜上没有第 99 名');
  });
});

describe('ArenaService · 开榜初始名次（按当时战力排）', () => {
  /** 三档战力各不相同：4 最强、1 其次、2 最弱；3 是 Lv.5 小号，7 没选使魔 */
  const seededOptions = () => ({
    powers: { 1: 5000, 2: 3000, 4: 9000, 3: 99999, 7: 99999 },
    players: {
      4: makePlayerRow(4),
      7: makePlayerRow(7, { type: '' }),
    },
  });

  it('全服零档案时按战力降序发席位，最强的人拿 1 号位', async () => {
    const { service, prisma } = makeService(seededOptions());
    const text = await service.seedInitialSeats();
    expect(text).toContain('初始排名完成');
    // 战力 9000 > 5000 > 3000 → 席位 3 > 2 > 1
    expect(seatsOf(prisma)).toEqual({ 4: 3, 1: 2, 2: 1 });
    expect(text).toContain('榜首战力 9000');
  });

  it('只建档案、不建镜像：没参与过竞技场的人不会平白变成别人能打的靶子', async () => {
    const { service, prisma } = makeService(seededOptions());
    await service.seedInitialSeats();
    expect(prisma.__tables.arenaMirror).toHaveLength(0);
    expect(prisma.__tables.arenaSeason).toHaveLength(1);
    // 榜是以镜像为准的，所以初始名次排完后榜面仍然是空的
    const rows = await service.ladderRows(prisma.__tables.arenaSeason[0].id, 1, 20);
    expect(rows.rows).toHaveLength(0);
  });

  it('低于开放等级、未选使魔的人不进初始名次', async () => {
    const { service, prisma } = makeService(seededOptions());
    await service.seedInitialSeats();
    const seated = prisma.__tables.arenaProfile.map((p: any) => Number(p.userId));
    expect(seated).not.toContain(3); // Lv.5 < arena.minLevelToEnter
    expect(seated).not.toContain(7); // type='' 还没选使魔
  });

  it('初始席位只是起点：先提交镜像的人不再自动排第一，席位按战力兑现到榜上', async () => {
    const { service, prisma } = makeService(seededOptions());
    await service.seedInitialSeats();
    // 1 先提交、4 后提交：没有初始排名的话 1 会占住第 1 名
    expect(await service.submitMirror(1)).toContain('当前第 1 名');
    const text = await service.submitMirror(4);
    expect(text).toContain('当前第 1 名');
    const seasonId = prisma.__tables.arenaSeason[0].id;
    const rows = await service.ladderRows(seasonId, 1, 20);
    expect(rows.rows.map((r) => r.ownerId)).toEqual([4, 1]);
    // 1 被挤到第 2 名，仍然只能一顺位往上打 4
    expect(await service.challengeMirror(1, '玩家4')).toContain('挑战成功');
  });

  it('已有档案就不再重排（不能覆盖已经打出来的名次）', async () => {
    const first = makeService(seededOptions());
    await first.service.submitMirror(2); // 单人提交：2 拿到 1 号席位
    const text = await first.service.seedInitialSeats();
    expect(text).toContain('跳过初始排名');
    expect(seatsOf(first.prisma)).toEqual({ 2: 1 });
    // 巡检口（quiet）在同样情形下不给任何文案，避免每小时刷一条日志
    expect(await first.service.seedInitialSeats(true)).toBe('');
  });

  it('开关关掉就一个都不排，入榜者仍按提交先后排队尾', async () => {
    const { service, prisma } = makeService({
      ...seededOptions(),
      configOverrides: { 'arena.rankInitByPower': false },
    });
    expect(await service.seedInitialSeats()).toContain('已关闭');
    expect(prisma.__tables.arenaProfile).toHaveLength(0);
  });

  it('战力相同按 userId 升序定序（同一份数据重复执行得到同一份名次）', async () => {
    const a = makeService({ powers: { 1: 4000, 2: 4000 }, players: { 1: makePlayerRow(1), 2: makePlayerRow(2) } });
    await a.service.seedInitialSeats();
    expect(seatsOf(a.prisma)).toEqual({ 1: 2, 2: 1 });
  });
});

describe('ArenaService · 练手局（打排名不高于自己的人）', () => {
  async function seeded(options: any = {}) {
    const h = makeService({ players: { 4: makePlayerRow(4), 5: makePlayerRow(5) }, ...options });
    for (const uid of [1, 2, 4, 5]) await h.service.submitMirror(uid);
    // 席位 1/0/-1/-2 → 名次 1/2/3/4
    return h;
  }

  it('打后面的人不再被拒：完整战报照出，但席位、名次、战绩一个字都不动', async () => {
    const { service, prisma, players } = await seeded();
    const before = seatsOf(prisma);
    const text = await service.challengeMirror(1, '玩家5');
    expect(text).toContain('练手');
    expect(text).toContain('不计成绩、不动席位');
    expect(prisma.__tables.arenaMatch).toHaveLength(1);
    const match = prisma.__tables.arenaMatch[0];
    expect(match.report.mode).toBe('practice');
    expect(match.report.seats.swapped).toBe(false);
    // 席位前后相等（审计上一眼能分辨练手局）
    expect(match.attackerRatingAfter).toBe(match.attackerRatingBefore);
    expect(match.defenderRatingAfter).toBe(match.defenderRatingBefore);
    expect(seatsOf(prisma)).toEqual(before);
    // 双方都不计胜败，连胜也不动
    for (const uid of [1, 5]) {
      const p = prisma.__tables.arenaProfile.find((x: any) => x.userId === uid);
      expect(Number(p.wins) + Number(p.losses) + Number(p.draws)).toBe(0);
      expect(Number(p.streak)).toBe(0);
    }
    // 免费：提交镜像的 10 点之外不多扣
    expect(players[1].vitality).toBe(100 - 10);
    expect(match.entryCost).toEqual({ mode: 'practice', amount: 0, item: '' });
  });

  it('练手局不占每日挑战次数：额度用光后正式局被拒、练手局照样打', async () => {
    const { service, prisma } = await seeded({ configOverrides: { 'arena.dailyChallengeLimit': 1 } });
    // 4（第 3 名）先打一场正式局：2（第 2 名），把唯一的次数用掉
    expect(await service.challengeMirror(4, '玩家2')).toContain('挑战');
    const attacker = prisma.__tables.arenaProfile.find((p: any) => p.userId === 4);
    expect(attacker.daily.used).toBe(1);
    // 同一人再打正式局（此时 2 已被顶到第 3、4 到第 2，前面是第 1 名的 1）→ 次数不够
    expect(await service.challengeMirror(4, '玩家1')).toContain('今日挑战次数已用完');
    // 但练手局（打排名不高于自己的 5）照样放行，而且不吃次数
    expect(await service.challengeMirror(4, '玩家5')).toContain('练手');
    expect(prisma.__tables.arenaProfile.find((p: any) => p.userId === 4).daily.used).toBe(1);
  });

  it('练手免费但照样吃防连打冷却（不能拿同一个人无限刷情报）', async () => {
    const { service } = await seeded();
    expect(await service.challengeMirror(1, '玩家5')).toContain('练手');
    expect(await service.challengeMirror(1, '玩家5')).toContain('后才能再挑战');
  });

  it('引擎异常时练手局不退款（本来就没扣，退成「已退还」就是假账）', async () => {
    const { service, prisma, playerService } = await seeded({ fight: () => { throw new Error('战斗引擎炸了'); } });
    const text = await service.challengeMirror(1, '玩家5');
    expect(text).toContain('结算异常');
    expect(text).not.toContain('已退还');
    expect(playerService.addToBackpack).not.toHaveBeenCalled();
    expect(prisma.__tables.arenaMatch).toHaveLength(0);
  });

  it('练手局不计入参与奖场次，战绩与接口都单独标出来', async () => {
    const { service, prisma } = await seeded();
    await service.challengeMirror(1, '玩家5');
    const history = await service.viewHistory(1, '');
    expect(history).toContain('练手');
    expect(history).toContain('不计成绩');
    const rows = await service.matchesForUser(1, 1);
    expect(rows.rows[0].practice).toBe(true);
    expect(rows.rows[0].swapped).toBe(false);
    // 参与奖判的是 wins+losses+draws，练手一场都不加
    const p1 = prisma.__tables.arenaProfile.find((p: any) => p.userId === 1);
    expect(Number(p1.wins) + Number(p1.losses) + Number(p1.draws)).toBe(0);
    // 正式局在接口里 practice=false
    await service.challengeMirror(2, '玩家1');
    const ladderRows = await service.matchesForUser(2, 1);
    expect(ladderRows.rows[0].practice).toBe(false);
  });
});

describe('ArenaService · 每日次数口径', () => {
  it('按本地日期懒重置（与签到 / 抽奖同一口径）', () => {
    const { service } = makeService();
    const cfg = { dailyChallengeLimit: 5 } as any;
    const today = arenaTodayString();
    const yesterday = arenaTodayString(new Date(Date.now() - 86400000));
    expect(service.readDaily({ daily: { lastDate: today, used: 3 } }, cfg).left).toBe(2);
    expect(service.readDaily({ daily: { lastDate: yesterday, used: 3 } }, cfg).left).toBe(5);
    expect(service.readDaily(null, cfg).left).toBe(5);
  });
});
