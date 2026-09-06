/**
 * 怪物反击全图玩家 + 卷土重来 端到端集成测试（真实远程 MySQL）
 *
 * 对应原版：战斗相关.ecode L4647-4713（怪物反击全图符合条件的玩家）
 *           战斗相关.ecode L3674（玩家被击杀 → 卷土重来状态满状态复活）
 *
 * 测试策略：
 *  - 启动真实 Nest ApplicationContext，获取 CombatSystemService / PlayerService /
 *    StatsService / MapService / PrismaService 真实实例（连远程 smdz 库）。
 *  - 动态创建两个测试账号（User + Player，同地图、标记为在线），避免干扰真实玩家。
 *  - 测试1 全图反击：A 攻击后怪物反击，断言同图另一在线玩家 B 也被反击扣血
 *    （验证"只反击攻击者"简化已废除，全图筛选生效）。
 *  - 测试2 卷土重来：把 B 血量压到 1，怪物反击必中且高伤 → B 死亡 →
 *    断言 B 进入"卷土重来"状态（生命保持 0 不回血 + buffs 含"卷土重来"，靠增益闪避=1 免死，60 秒冷却内不重复触发）。
 *  - afterAll 清理两个测试账号（User 级联删 Player）。
 *
 * 注：真实玩家若与测试账号同地图也会被反击，但本测试只断言测试账号受影响，无害。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { StatsService } from '../src/modules/game/stats.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120000);

describe('怪物反击全图 + 卷土重来（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let combat: CombatSystemService;
  let playerService: PlayerService;
  let mapService: MapService;
  let statsService: StatsService;

  const createdUserIds: number[] = [];
  const createdMapIds: number[] = [];
  let mapId = 0;
  let monsterId = 0;

  const stamp = () => Math.random().toString(36).slice(2, 8);

  async function setupIsolatedMap(): Promise<number> {
    const map = await prisma.gameMap.create({
      data: {
        name: 'counter_e2e_' + Date.now() + '_' + stamp(),
        description: '怪物反击集成测试专用地图',
        // noSpecial：定时任务（掉落货舱/生成副本/行商判断）按该标志跳过本地图，
        // 避免 afterAll 未执行（进程中断）时泄漏的地图被当成普通地图吸走每小时投放的货舱/能量元素
        noSpecial: true,
        vehicles: JSON.stringify([]),
        markers: JSON.stringify({}),
        markers2: JSON.stringify([]),
        summons: JSON.stringify([]),
        items: JSON.stringify([]),
      },
    });
    createdMapIds.push(map.id);
    return map.id;
  }

  async function setupControlledMonster() {
    return mapService.addTempMonster(mapId, {
      name: '反击测试怪_' + stamp(),
      type: '反击测试怪',
      hp: 1000,
      maxHp: 1000,
      attack: 0,
      hit: 500,
      dodge: 0,
      specialSeq: -1,
      markers: '[]',
      markers2: '[]',
      bonus: JSON.stringify({
        攻击: 200, 命中: 500, 闪避: 0, 生命: 1000,
        护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
        装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
        生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      }),
    });
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    combat = app.get(CombatSystemService);
    playerService = app.get(PlayerService);
    mapService = app.get(MapService);
    statsService = app.get(StatsService);

    // 防复发清理（2026-09-06 事故）：进程中断导致 afterAll 未执行时，e2e 测试地图会
    // 泄漏进真实库并被定时任务当成普通地图（累计吸走货舱/能量元素、挂副本入口）。
    // 每次测试启动先按命名标记清一次历史残留，保证幂等。
    try {
      const staleMaps = await prisma.gameMap.findMany({ where: { name: { contains: '_e2e_' } }, select: { id: true } });
      for (const stale of staleMaps) {
        await prisma.gameMonster.deleteMany({ where: { mapId: stale.id } });
        await prisma.gameMap.delete({ where: { id: stale.id } });
      }
    } catch { /* 清理失败不阻塞测试 */ }

    // 专用地图与受控怪物，避免共享出生地图刷新状态导致环境脆弱。
    await (playerService as any).resolveStartMap();
    mapId = await setupIsolatedMap();
    const monster = await setupControlledMonster();
    monsterId = monster.id;

    // 创建两个测试账号（同地图、在线）
    for (const tag of ['a', 'b']) {
      const username = `e2e_counter_${tag}_${stamp()}`;
      const user = await prisma.user.create({
        data: { username, password: 'e2e_test', role: 'USER' },
      });
      createdUserIds.push(user.id);
      await prisma.player.create({
        data: {
          userId: user.id,
          mapId,
          name: `端到端测试${tag}`,
          hp: 100, maxHp: 100,
          shield: 0, maxShield: 0,
          armor: 0, maxArmor: 0,
          level: 1,
          markers: '{}', markers2: '[]', buffs: '[]',
          backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
        },
      });
      // 标记为在线（对应原版"活跃"增益=在线，怪物反击筛选条件之一）
      // onlineUsers 为「userId → 连接数」引用计数 Map，非 Set
      (StatsService as any).onlineUsers.set(user.id, 1);
    }
  });

  afterAll(async () => {
    // 清理测试账号（User 级联删 Player）
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
      (StatsService as any).onlineUsers.delete(uid);
    }
    for (const id of createdMapIds) {
      try { await prisma.gameMonster.deleteMany({ where: { mapId: id } }); } catch { /* 已清 */ }
      try { await prisma.gameMap.delete({ where: { id } }); } catch { /* 已删 */ }
    }
    if (app) await app.close();
  });

  // 取存活怪物对象（自带 hp 等字段）
  async function getMonster() {
    const list = await mapService.getAliveMapMonsters(mapId);
    return list.find((m: any) => m.id === monsterId) || list[0];
  }

  // 读取玩家当前数据
  async function getPlayer(uid: number) {
    return playerService.getPlayerData(uid);
  }

  it('测试1 全图反击：A 攻击后，同图在线玩家 B 也被怪物反击扣血', async () => {
    const [uidA, uidB] = createdUserIds;
    const beforeB = await getPlayer(uidB);
    const beforeBhp = beforeB.player.hp;

    // 受控怪物属性：高命中、无闪避（确保反击必中），低伤（只扣血不致死，便于断言仍存活）
    jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
      攻击: 200, 命中: 300, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
      护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
      装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
      生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
    } as any);
    // 固定小伤害 10（三池全扣 hp），让 B 被反击后掉血但不死
    jest.spyOn(combat as any, 'calcDamage').mockReturnValue({
      damage: 10, poolDamage: { shield: 0, armor: 0, hp: 10 }, rating: '', critMultiplier: 1,
    } as any);

    const monster = await getMonster();
    const attackerData = await getPlayer(uidA);
    const map = await mapService.getMapById(mapId);

    // 直接驱动私有 monsterCounterAttack（复刻原版 战斗() 怪物攻击分支）
    const lines = await (combat as any).monsterCounterAttack(
      attackerData.player, attackerData, map,
    );

    const afterB = await getPlayer(uidB);

    // 全图反击生效：文本应同时含对"你"(攻击者)和"端到端测试b"(非攻击者)的攻击动作，
    // 证明"只反击攻击者"简化已废除，全图筛选（在线/存活/非隐匿/非炮冠）生效。
    // 怪物对每位防御方独立做命中/闪避判定 → 可能"造成...伤害"也可能"被...闪避了"，两种均证明全图反击发生。
    const text = lines.join('\n');
    expect(text).toContain('你');                            // 攻击者 A 被怪物攻击（含"攻击你"/"向你发起攻击"）
    expect(text).toContain('端到端测试b');                   // 非攻击者 B 也被怪物攻击（全图）
    // B 受到反击：要么扣血（hp 下降），要么闪避（hp 不变但仍被攻击）。只要"被攻击"动作发生即达标。
    const bAttacked = afterB.player.hp < beforeBhp || text.includes('被端到端测试b闪避了');
    expect(bAttacked).toBe(true);
    expect(afterB.player.hp).toBeGreaterThan(0);
  });

  it('测试2 卷土重来：B 被反击致死 → 进入卷土重来免死状态（生命保持 0，不回血）', async () => {
    const [, uidB] = createdUserIds;

    // B 血量压到 1，确保被反击一击致死
    const pd = await getPlayer(uidB);
    pd.player.hp = 1;
    await playerService.savePlayer(pd.player);

    // 高命中、必中、高伤（确保击杀）
    jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
      攻击: 500, 命中: 500, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
      护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
      装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
      生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
    } as any);
    jest.spyOn(combat as any, 'calcDamage').mockReturnValue({
      damage: 999, poolDamage: { shield: 0, armor: 0, hp: 999 }, rating: '', critMultiplier: 1,
    } as any);

    const attackerData = await getPlayer(createdUserIds[0]);
    const map = await mapService.getMapById(mapId);

    // 以「反击调用前的本地秒」为基准断言增益时长：服务端到期时间戳 = 内部写入时刻 +
    // 固定时长（30+卷土重来属性，本例无加成=30 秒），与远程库读回延迟解耦
    // （旧写法用读回时刻反推剩余时间，全量并发时读链路一旦变慢即假红）。
    const tCounter = Date.now() / 1000;
    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const afterB = await getPlayer(uidB);
    const tRead = Date.now() / 1000;
    const bBuffs = JSON.parse(afterB.player.buffs || '[]');
    const comeback = bBuffs.find((b: any) => b.name === '卷土重来');

    // 卷土重来只给增益、不回血（原版 L3674）：生命保持 0，靠增益闪避=1 免死，
    // 等待宠物扶起（HP=属性.生命/2）或 30 秒后增益过期真死。故 hp 应为 0 而非上限。
    expect(afterB.player.hp).toBe(0);
    // 进入卷土重来状态：到期时间戳 = 内部写入时刻(∈[调用前, 读回前]) + 30 秒，两端夹逼、抗延迟。
    // 写入侧 nowSecV 是 Math.floor 秒级取整，下界额外放宽 1 秒取整损耗。
    expect(comeback).toBeDefined();
    expect(comeback.expireAt).toBeGreaterThanOrEqual(tCounter + 30 - 1.05);
    expect(comeback.expireAt).toBeLessThanOrEqual(tRead + 30 + 0.05);
  });
});
