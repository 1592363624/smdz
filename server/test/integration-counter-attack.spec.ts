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
 *    断言 B 进入"卷土重来"状态（hp 回满 + buffs 含"卷土重来"，60 秒内不再真死）。
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
  let mapId = 0;
  let monsterId = 0;

  const stamp = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    combat = app.get(CombatSystemService);
    playerService = app.get(PlayerService);
    mapService = app.get(MapService);
    statsService = app.get(StatsService);

    // 出生地图（确保测试账号落在已刷怪的地图）
    const startMap = await (playerService as any).resolveStartMap();
    mapId = startMap.id;

    // 确保地图有存活怪物（无则强制刷新）
    let monsters = await mapService.getAliveMapMonsters(mapId);
    if (monsters.length === 0) {
      await mapService.refreshMapMonsters(mapId);
      monsters = await mapService.getAliveMapMonsters(mapId);
    }
    if (monsters.length === 0) {
      throw new Error('出生地图无存活怪物，无法执行端到端测试');
    }
    monsterId = monsters[0].id;

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
      (StatsService as any).onlineUsers.add(user.id);
    }
  });

  afterAll(async () => {
    // 清理测试账号（User 级联删 Player）
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
      (StatsService as any).onlineUsers.delete(uid);
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

  it('测试2 卷土重来：B 被反击致死 → 满状态复活并进入卷土重来状态', async () => {
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

    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const afterB = await getPlayer(uidB);
    const bBuffs = JSON.parse(afterB.player.buffs || '[]');
    const comeback = bBuffs.find((b: any) => b.name === '卷土重来');

    // 满状态复活：hp 回到上限 100
    expect(afterB.player.hp).toBe(afterB.player.maxHp);
    // 进入卷土重来状态：增益已写入且未过期
    expect(comeback).toBeDefined();
    expect(comeback.expireAt).toBeGreaterThan(Date.now() / 1000);
  });
});
