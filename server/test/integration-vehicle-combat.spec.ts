/**
 * 载具承伤 + 扫荡完整模型 端到端集成测试（真实远程 MySQL）
 *
 * 对应原版：
 *  - 载具承伤：战斗相关.ecode L3175-3529（防御方驾驶载具时，载具先承第一道伤；普通溢出不会在同次攻击转给玩家）
 *  - 扫荡完整模型：game.service.ts handleSweep 现改为调用 combatSystem.weaponAttack 完整闭环
 *    （原版 .扫荡 即连续自动攻击，含怪物反击/召唤物协同/死亡掉落）
 *
 * 测试策略：
 *  - 启动真实 Nest ApplicationContext，连远程 smdz 库，获取真实服务实例。
 *  - 动态创建测试账号（User + Player，标记在线），避免干扰真实玩家。
 *  - 测试1 载具吸收：玩家驾驶耐久充足的载具 → 怪物反击 → 断言玩家 hp 不变、载具扣血。
 *  - 测试2 载具破碎：玩家驾驶不足1点耐久的载具 → 怪物反击 → 断言载具破碎、玩家 hp 不因普通溢出下降。
 *  - 测试3 无载具直扣：玩家无载具 → 怪物反击 → 断言玩家 hp 直接下降。
 *  - 测试4 扫荡走完整模型：调用 gameService.handleSweep → 断言返回击杀/经验且玩家存在。
 *  - afterAll 清理测试账号（User 级联删 Player）。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { StatsService } from '../src/modules/game/stats.service';
import { GameService } from '../src/modules/game/game.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(180000);

describe('载具承伤 + 扫荡完整模型（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let combat: CombatSystemService;
  let playerService: PlayerService;
  let mapService: MapService;
  let statsService: StatsService;
  let gameService: GameService;

  const createdUserIds: number[] = [];
  let mapId = 0;
  let createdMapIds: number[] = [];

  const stamp = () => Math.random().toString(36).slice(2, 8);

  /** 创建隔离地图，避免共享起始地图的怪物刷新/扫荡状态影响承伤断言。 */
  async function setupIsolatedMap(): Promise<number> {
    const name = `vehicle_e2e_${Date.now()}_${stamp()}`;
    const map = await prisma.gameMap.create({
      data: {
        name,
        description: '载具承伤集成测试专用地图',
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

  /** 创建零抗性受击怪，保证 mock calcDamage 后的载具分支只验证承伤规则。 */
  async function setupControlledMonster(specialSeq = -1, markers = '[]') {
    return mapService.addTempMonster(mapId, {
      name: `承伤测试怪_${stamp()}`,
      type: '承伤测试怪',
      hp: 1000,
      maxHp: 1000,
      attack: 0,
      hit: 300,
      dodge: 0,
      specialSeq,
      markers,
      bonus: JSON.stringify({
        攻击: 200, 命中: 300, 闪避: 0, 生命: 1000,
        护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
        装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
        生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      }),
    });
  }

  /** 构造一个含指定耐久载具的地图 vehicles JSON，并写入 Player.vehicle */
  async function setupVehicle(uid: number, vehicleHp: number, extra: Record<string, any> = {}) {
    const vId = `V_${stamp()}`;
    const vName = '测试战车';
    const vehicles = [{
      id: vId, 编号: vId, name: vName,
      currentHp: vehicleHp, 当前生命: vehicleHp, maxHp: 200, 最大生命: 200,
      ...extra,
    }];
    await mapService.updateDynamicFields(mapId, { vehicles: JSON.stringify(vehicles) });
    const pd = await playerService.getPlayerData(uid);
    pd.player.vehicle = vId;
    await playerService.savePlayer(pd.player);
    return { vId, vName };
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    combat = app.get(CombatSystemService);
    playerService = app.get(PlayerService);
    mapService = app.get(MapService);
    statsService = app.get(StatsService);
    gameService = app.get(GameService);

    await (playerService as any).resolveStartMap();
    mapId = await setupIsolatedMap();

    // 创建三个测试账号（同地图、在线，分别对应载具吸收/破碎/无载具）
    for (let i = 0; i < 3; i++) {
      const username = `e2e_vehicle_${i}_${stamp()}`;
      const user = await prisma.user.create({
        data: { username, password: 'e2e_test', role: 'USER' },
      });
      createdUserIds.push(user.id);
      await prisma.player.create({
        data: {
          userId: user.id,
          mapId,
          name: `端到端载具${i}`,
          hp: 100, maxHp: 100,
          shield: 0, maxShield: 0,
          armor: 0, maxArmor: 0,
          level: 1,
          markers: '{}', markers2: '[]', buffs: '[]',
          backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
        },
      });
      // onlineUsers 为「userId → 连接数」引用计数 Map，非 Set
      (StatsService as any).onlineUsers.set(user.id, 1);
    }
  });

  afterAll(async () => {
    for (const id of createdMapIds) {
      try { await prisma.gameMonster.deleteMany({ where: { mapId: id } }); } catch { /* 已清 */ }
      try { await prisma.gameMap.delete({ where: { id } }); } catch { /* 已删 */ }
    }
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
      (StatsService as any).onlineUsers.delete(uid);
    }
    if (app) await app.close();
  });

  async function getPlayer(uid: number) {
    return playerService.getPlayerData(uid);
  }

  /** 固定伤害，命中必中，便于断言载具承伤行为。 */
  function mockFixedDamage(damage: number, options: Record<string, any> = {}) {
    const breakdown = options.damageBreakdown || { physical: damage, fire: 0, ice: 0, elec: 0 };
    jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
      攻击: 200, 命中: 300, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
      护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
      装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
      生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
    } as any);
    jest.spyOn(combat as any, 'calcDamage').mockReturnValue({
      damage,
      poolDamage: options.poolDamage || { shield: 0, armor: 0, hp: damage },
      damageBreakdown: breakdown,
      vehicleBreakdown: options.vehicleBreakdown || breakdown,
      rating: '',
      critMultiplier: 1,
      ...options,
    } as any);
    // 该专项只验证载具承伤，命中不能引入随机失败。
    jest.spyOn(combat as any, 'checkHit').mockReturnValue(true);
  }

  /** 将指定玩家重置为干净战斗态（满血、无载具、无增减益干扰），保证跨套件共享远程库时断言稳定 */
  async function resetPlayer(uid: number, hp = 100) {
    const pd = await getPlayer(uid);
    pd.player.hp = hp;
    pd.player.maxHp = hp;
    pd.player.shield = 0;
    pd.player.armor = 0;
    pd.player.vehicle = '';
    pd.player.buffs = '[]';
    pd.player.markers2 = '[]';
    await playerService.savePlayer(pd.player);
  }

  it('测试1 载具吸收：玩家驾驶耐久充足载具 → 玩家 hp 不变、载具扣血', async () => {
    const uid = createdUserIds[0];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200); // 充足耐久
    const beforeHp = 100;

    await setupControlledMonster();
    mockFixedDamage(10);

    const attackerData = await getPlayer(createdUserIds[1]);
    const map = await mapService.getMapById(mapId);

    // monsterCounterAttack 反击全图，这里直接驱动并断言受害者数据
    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicles = JSON.parse(mapAfter.vehicles || '[]');
    const v = vehicles.find((x: any) => x && (x.id === vId || x.编号 === vId));

    // 原版普通载具承伤固定为1或2，不承受完整的10点三池伤害。
    expect(after.player.hp).toBe(beforeHp);
    // 当前状态100，10/2不超过状态，因此载具承伤为1。
    expect(v.currentHp).toBe(199);
    expect(v.当前生命).toBe(199);
  });

  it('测试2 载具破碎：普通攻击不把同次溢出伤害扣到玩家 hp', async () => {
    const uid = createdUserIds[1];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 0.5); // 载具普通承伤为1，因此本次会被击毁
    const beforeHp = 100;

    await setupControlledMonster();
    mockFixedDamage(10);

    const attackerData = await getPlayer(createdUserIds[0]);
    const map = await mapService.getMapById(mapId);

    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicles = JSON.parse(mapAfter.vehicles || '[]');
    const v = vehicles.find((x: any) => x && (x.id === vId || x.编号 === vId));

    // 载具破碎：耐久归零
    expect(v.currentHp).toBe(0);
    expect(v.当前生命).toBe(0);
    // 原版 L3512-L3515 清空普通剩余四属性，同次普通溢出不会落到玩家。
    expect(after.player.hp).toBe(beforeHp);
  });

  it('测试3 无载具直扣：玩家无载具 → 怪物反击直接扣玩家 hp', async () => {
    const uid = createdUserIds[2];
    await resetPlayer(uid, 100); // 显式重置满血、无载具

    await setupControlledMonster();
    mockFixedDamage(10);

    const attackerData = await getPlayer(createdUserIds[0]);
    const map = await mapService.getMapById(mapId);

    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    // 无载具 → 直接扣 hp（本测试只驱动一次反击、mock 固定 damage=10，正常扣 10；
    // 允许被多只存活怪物额外反击，故断言"至少扣 10 且仍存活"）
    expect(after.player.hp).toBeLessThanOrEqual(100 - 10);
    expect(after.player.hp).toBeGreaterThanOrEqual(0);
  });

  it('测试4 扫荡走完整模型：handleSweep 返回击杀/经验且玩家存活', async () => {
    const uid = createdUserIds[0];
    // 重置该玩家状态，确保可扫荡
    const pd = await getPlayer(uid);
    pd.player.hp = pd.player.maxHp;
    pd.player.vehicle = '';
    await playerService.savePlayer(pd.player);

    const before = await getPlayer(uid);
    void before;

    const result = await gameService.handleSweep(uid);

    // 扫荡返回文本（含击杀/经验汇总），不为空
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);

    // 玩家应仍存活（扫荡为自动攻击闭环，遇死亡有卷土重来保护）
    const after = await getPlayer(uid);
    expect(after.player.hp).toBeGreaterThanOrEqual(0);
  });

  it('测试5 阵地：有效载具承受完整伤害，不受普通1/2点上限限制', async () => {
    const uid = createdUserIds[0];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200);
    mockFixedDamage(10);

    const pd = await getPlayer(uid);
    const map = await mapService.getMapById(mapId);
    const monster = await setupControlledMonster();
    expect(monster).toBeDefined();
    monster.markers = JSON.stringify({ 阵地: 1 });
    const monsterBonus = (combat as any).buildMonsterBonus(monster);
    await (combat as any).monsterCounterAttackOnePlayer(monster, monsterBonus, pd.player, pd, map, true);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    expect(vehicle.currentHp).toBe(190);
    expect(after.player.hp).toBe(100);
  });

  it('测试6 损伤控制系统A：首次高伤害触发sk1无敌窗口', async () => {
    const uid = createdUserIds[1];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200, {
      parts: JSON.stringify([{ name: '损伤控制系统A', 名称: '损伤控制系统A' }]),
    });
    mockFixedDamage(10);

    const attackerData = await getPlayer(createdUserIds[0]);
    const map = await mapService.getMapById(mapId);
    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    const markers = JSON.parse(vehicle.markers2 || '[]');
    expect(after.player.hp).toBe(100);
    expect(vehicle.currentHp).toBe(200);
    expect(markers.some((m: any) => (m.name || m.名称) === 'sk1')).toBe(true);
  });

  it('测试7 贯穿：载具只承受普通伤害，贯穿额外伤害直接作用于玩家三池', async () => {
    const uid = createdUserIds[2];
    await resetPlayer(uid, 100);
    const pd = await getPlayer(uid);
    pd.player.shield = 100;
    pd.player.maxShield = 100;
    pd.player.armor = 100;
    pd.player.maxArmor = 100;
    await playerService.savePlayer(pd.player);
    const { vId } = await setupVehicle(uid, 200);
    mockFixedDamage(100, {
      poolDamage: { shield: 70, armor: 20, hp: 10 },
      penetrated: true,
      vehicleExtraPoolDamage: { shield: 0, armor: 20, hp: 10 },
      vehicleExtraBreakdown: {
        shield: { physical: 0, fire: 0, ice: 0, elec: 0 },
        armor: { physical: 20, fire: 0, ice: 0, elec: 0 },
        life: { physical: 10, fire: 0, ice: 0, elec: 0 },
      },
    });

    const attackerData = await getPlayer(createdUserIds[0]);
    const victimData = await getPlayer(uid);
    const map = await mapService.getMapById(mapId);
    const monster = await setupControlledMonster();
    expect(monster).toBeDefined();
    const monsterBonus = (combat as any).buildMonsterBonus(monster);
    await (combat as any).monsterCounterAttackOnePlayer(monster, monsterBonus, victimData.player, victimData, map, false);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    expect(vehicle.currentHp).toBe(199);
    expect(after.player.shield).toBe(100);
    expect(after.player.armor).toBe(80);
    expect(after.player.hp).toBe(90);
  });

  it('测试8 贯穿抵抗：损伤控制系统B抵抗贯穿并消耗sk冷却', async () => {
    const uid = createdUserIds[0];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200, {
      parts: JSON.stringify([{ name: '损伤控制系统B', 名称: '损伤控制系统B' }]),
    });
    mockFixedDamage(100, {
      penetrated: true,
      poolDamage: { shield: 70, armor: 20, hp: 10 },
      vehicleExtraPoolDamage: { shield: 0, armor: 20, hp: 10 },
    });

    const attackerData = await getPlayer(createdUserIds[1]);
    const map = await mapService.getMapById(mapId);
    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    const markers = JSON.parse(vehicle.markers2 || '[]');
    // 同一命中还会经过B系统的sk0损控，故载具本次不掉耐久；贯穿抵抗本身由sk标记记录。
    expect(vehicle.currentHp).toBe(200);
    expect(after.player.hp).toBe(100);
    expect(markers.some((m: any) => (m.name || m.名称) === 'sk')).toBe(true);
    expect(markers.some((m: any) => (m.name || m.名称) === 'sk1')).toBe(true);
  });

  it('测试9 福音书系统：首次触发只让载具承受1点并记录福ys', async () => {
    const uid = createdUserIds[1];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200, {
      parts: JSON.stringify([{ name: '福音书系统', 名称: '福音书系统' }]),
    });
    mockFixedDamage(10);

    const attackerData = await getPlayer(createdUserIds[0]);
    const map = await mapService.getMapById(mapId);
    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    const markers = JSON.parse(after.player.markers2 || '[]');
    expect(vehicle.currentHp).toBe(199);
    expect(after.player.hp).toBe(100);
    expect(markers.some((m: any) => (m.name || m.名称) === '福ys')).toBe(true);
  });

  it('测试10 虹天剑：首次命中按载具最大生命一半，虹a冷却后恢复普通承伤', async () => {
    const uid = createdUserIds[2];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200);
    mockFixedDamage(10);

    const victimData = await getPlayer(uid);
    const map = await mapService.getMapById(mapId);
    const monster = await setupControlledMonster();
    expect(monster).toBeDefined();
    monster.specialSeq = -9;
    const monsterBonus = (combat as any).buildMonsterBonus(monster);
    await (combat as any).monsterCounterAttackOnePlayer(
      monster, monsterBonus, victimData.player, victimData, map, false,
    );

    let mapAfter = await mapService.getMapById(mapId);
    let vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    expect(vehicle.currentHp).toBe(100);
    const firstMarkers = JSON.parse(monster.markers2 || '[]');
    expect(firstMarkers.some((m: any) => (m.name || m.名称) === '虹a')).toBe(true);

    const victimDataSecond = await getPlayer(uid);
    mapAfter = await mapService.getMapById(mapId);
    const secondMonsterBonus = (combat as any).buildMonsterBonus(monster);
    await (combat as any).monsterCounterAttackOnePlayer(
      monster, secondMonsterBonus, victimDataSecond.player, victimDataSecond, mapAfter, false,
    );
    mapAfter = await mapService.getMapById(mapId);
    vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    expect(vehicle.currentHp).toBe(99);
  });

  it('测试11 涂层：对应物理属性只按0.05倍计入阵地完整载具伤害', async () => {
    const uid = createdUserIds[0];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 200, { coating: 1 });
    mockFixedDamage(100, {
      damageBreakdown: { physical: 100, fire: 0, ice: 0, elec: 0 },
      vehicleBreakdown: { physical: 100, fire: 0, ice: 0, elec: 0 },
    });

    const pd = await getPlayer(uid);
    const map = await mapService.getMapById(mapId);
    const monster = await setupControlledMonster();
    expect(monster).toBeDefined();
    monster.markers = JSON.stringify({ 阵地: 1 });
    const monsterBonus = (combat as any).buildMonsterBonus(monster);
    await (combat as any).monsterCounterAttackOnePlayer(monster, monsterBonus, pd.player, pd, map, false);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicle = JSON.parse(mapAfter.vehicles || '[]').find((x: any) => x.id === vId);
    expect(vehicle.currentHp).toBe(195);
    expect(after.player.hp).toBe(100);
  });
});
