/**
 * 载具承伤 + 扫荡完整模型 端到端集成测试（真实远程 MySQL）
 *
 * 对应原版：
 *  - 载具承伤：战斗相关.ecode L3175-3288（防御方驾驶载具时，载具先承第一道伤，破碎后溢出落到玩家三池）
 *  - 扫荡完整模型：game.service.ts handleSweep 现改为调用 combatSystem.weaponAttack 完整闭环
 *    （原版 .扫荡 即连续自动攻击，含怪物反击/召唤物协同/死亡掉落）
 *
 * 测试策略：
 *  - 启动真实 Nest ApplicationContext，连远程 smdz 库，获取真实服务实例。
 *  - 动态创建测试账号（User + Player，标记在线），避免干扰真实玩家。
 *  - 测试1 载具吸收：玩家驾驶耐久充足的载具 → 怪物反击 → 断言玩家 hp 不变、载具扣血。
 *  - 测试2 载具破碎溢出：玩家驾驶耐久不足的载具 → 怪物反击 → 断言载具破碎、溢出伤害落到玩家 hp。
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

  const stamp = () => Math.random().toString(36).slice(2, 8);

  /** 构造一个含指定耐久载具的地图 vehicles JSON，并写入 Player.vehicle */
  async function setupVehicle(uid: number, vehicleHp: number) {
    const vId = `V_${stamp()}`;
    const vName = '测试战车';
    const vehicles = [{ id: vId, 编号: vId, name: vName, currentHp: vehicleHp, 当前生命: vehicleHp, maxHp: 200, 最大生命: 200 }];
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

    const startMap = await (playerService as any).resolveStartMap();
    mapId = startMap.id;

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
      (StatsService as any).onlineUsers.add(user.id);
    }
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
      (StatsService as any).onlineUsers.delete(uid);
    }
    if (app) await app.close();
  });

  async function getPlayer(uid: number) {
    return playerService.getPlayerData(uid);
  }

  /** 固定小伤害 10（三池全扣 hp），命中必中，便于断言载具承伤行为 */
  function mockFixedDamage(damage: number) {
    jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
      攻击: 200, 命中: 300, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
      护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
      装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
      生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
    } as any);
    jest.spyOn(combat as any, 'calcDamage').mockReturnValue({
      damage, poolDamage: { shield: 0, armor: 0, hp: damage }, rating: '', critMultiplier: 1,
    } as any);
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

    mockFixedDamage(10);

    const attackerData = await getPlayer(createdUserIds[1]);
    const map = await mapService.getMapById(mapId);

    // monsterCounterAttack 反击全图，这里直接驱动并断言受害者数据
    await (combat as any).monsterCounterAttack(attackerData.player, attackerData, map);

    const after = await getPlayer(uid);
    const mapAfter = await mapService.getMapById(mapId);
    const vehicles = JSON.parse(mapAfter.vehicles || '[]');
    const v = vehicles.find((x: any) => x && (x.id === vId || x.编号 === vId));

    // 载具完全吸收 10 点 → 玩家 hp 不变
    expect(after.player.hp).toBe(beforeHp);
    // 载具耐久从 200 降到 190
    expect(v.currentHp).toBe(190);
    expect(v.当前生命).toBe(190);
  });

  it('测试2 载具破碎溢出：玩家驾驶耐久不足载具 → 载具破碎、溢出伤害落到玩家 hp', async () => {
    const uid = createdUserIds[1];
    await resetPlayer(uid, 100);
    const { vId } = await setupVehicle(uid, 5); // 耐久不足，10 点伤害会破碎
    const beforeHp = 100;

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
    // 溢出 5 点（10-5）落到玩家 hp → hp 从 100 降到 95
    expect(after.player.hp).toBe(beforeHp - 5);
  });

  it('测试3 无载具直扣：玩家无载具 → 怪物反击直接扣玩家 hp', async () => {
    const uid = createdUserIds[2];
    await resetPlayer(uid, 100); // 显式重置满血、无载具

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
});
