/**
 * 「显示倍率」设置项 端到端集成测试（真实远程 MySQL）
 *
 * 对应原版：
 *   数据显示.ecode L996-1006（显示伤害倍率 子程序）
 *      L999  .如果真 (攻击方.使魔序号 > 0)            ' 仅玩家攻击时显示
 *      L1000 .如果真 (取成就熟练度(攻击方.标记,"bl") == 1)  ' 设置项「显示倍率」
 *      L1001 攻击加成 = (100 + ((1+电伤2%)*(1+电伤2%) + ... - 4)*100) * (1+攻击2%)
 *      L1002 返回 加括号("倍率" + 文本四舍(攻击加成) + "%")
 *   战斗相关.ecode 调用点：
 *      L1561 未命中分支 / L1698 被闪避分支 / L3881 命中分支
 *
 * 测试策略：
 *   - 真实 Nest ApplicationContext + 真实远程 smdz 库，走完整 weaponAttack 闭环
 *     （不 mock 加成计算，验证「设置面板写入 bl」→「buildAttackerBonus 留档」
 *       →「攻击文本拼接」整条链路真实打通）。
 *   - 命中分支与未命中分支分别覆盖，对应原版 L3881 / L1561+L1698 两个接入点。
 *   - afterAll 清理测试地图与账号。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { StatsService } from '../src/modules/game/stats.service';
import { GameService } from '../src/modules/game/game.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseJson } from './parse-json.util';

jest.setTimeout(180000);

describe('显示倍率设置项（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let combat: CombatSystemService;
  let playerService: PlayerService;
  let mapService: MapService;
  let gameService: GameService;

  const createdUserIds: number[] = [];
  const createdMapIds: number[] = [];
  let mapId = 0;

  const stamp = () => Math.random().toString(36).slice(2, 8);
  /** 原版输出形态：加括号("倍率" + 文本四舍(x) + "%") → "(倍率123.45%)" */
  const MULT_PATTERN = /\(倍率-?[\d.]+%\)/;

  async function setupIsolatedMap(): Promise<number> {
    const map = await prisma.gameMap.create({
      data: {
        name: `mult_e2e_${Date.now()}_${stamp()}`,
        description: '显示倍率集成测试专用地图',
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

  /**
   * 创建玩家；bl 为 undefined 时不写入标记（对应默认关）。
   * specialSeq=1（>0）才会显示倍率，对应原版 L999「攻击方.使魔序号 > 0」。
   */
  async function makePlayer(bl?: number): Promise<number> {
    const user = await prisma.user.create({
      data: { username: `e2e_mult_${stamp()}`, password: 'e2e_test', role: 'USER' },
    });
    createdUserIds.push(user.id);
    const markers: Record<string, number> = {};
    if (bl !== undefined) markers.bl = bl;
    await prisma.player.create({
      data: {
        userId: user.id,
        mapId,
        name: `倍率测试${stamp()}`,
        type: '花园猫',
        specialSeq: 1,
        affinity: 0,
        hp: 500, maxHp: 500,
        shield: 0, maxShield: 0,
        armor: 0, maxArmor: 0,
        level: 1,
        markers: JSON.stringify(markers),
        markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    // onlineUsers 为「userId → 连接数」引用计数 Map，非 Set
    (StatsService as any).onlineUsers.set(user.id, 1);
    return user.id;
  }

  /**
   * 零攻击受击怪：只作为挨打目标，避免反击伤害干扰断言。
   * dodge 传高值即可让真实命中判定必然失败，用于覆盖未命中/被闪避分支
   * （不 mock checkHit：全局 mock 会连带影响怪物反击等其它调用点）。
   */
  async function setupDummyMonster(dodge = 0) {
    return mapService.addTempMonster(mapId, {
      name: `倍率靶怪_${stamp()}`,
      type: '倍率靶怪',
      hp: 100000,
      maxHp: 100000,
      attack: 0,
      hit: 300,
      dodge,
      specialSeq: -1,
      markers: '[]',
      bonus: JSON.stringify({
        攻击: 0, 命中: 300, 闪避: dodge, 生命: 100000,
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
    gameService = app.get(GameService);

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

    await (playerService as any).resolveStartMap();
  });

  /**
   * 每个用例开一张独立地图：否则同一地图会累积前面用例留下的怪与玩家，
   * 攻击目标随机、怪物反击也会打到其它用例的账号，导致断言不稳定。
   */
  async function freshMap(): Promise<number> {
    mapId = await setupIsolatedMap();
    return mapId;
  }

  // checkHit 是全局 spy，必须逐用例还原，否则「恒 false」会泄漏到后续用例
  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
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

  it('测试1 标记 bl 未设置（默认关）→ 攻击文本不含倍率', async () => {
    await freshMap();
    const uid = await makePlayer();
    await setupDummyMonster();

    // 走指令入口 gameService.handleAttack（首次攻击无武器冷却）
    const text = await gameService.handleAttack(uid);
    expect(text).toBeTruthy();
    expect(text).not.toMatch(MULT_PATTERN);
  });

  /**
   * 直接走战斗子系统攻击（noDelay 绕过武器冷却，便于在同账号内连续多次攻击）。
   * 返回攻击结果文本。
   */
  async function attack(uid: number): Promise<string> {
    const r = await combat.weaponAttack(uid, 0, { noDelay: true });
    return r.result;
  }

  /**
   * 命中行特征：倍率紧跟攻击文本、位于伤害文本之前 → 「...(倍率100%) 靶怪，造成 ...」。
   * 限定 [^，\n] 不跨行，否则会把下一行「怪物反击 ... 造成 0」误判为命中行。
   */
  const HIT_LINE = new RegExp(`${MULT_PATTERN.source}[^，\\n]*，造成`);

  it('测试2 标记 bl=0（显式关）→ 攻击文本不含倍率', async () => {
    await freshMap();
    const uid = await makePlayer(0);
    await setupDummyMonster();

    expect(await attack(uid)).not.toMatch(MULT_PATTERN);
  });

  it('测试3 标记 bl=1 → 命中分支(L3881) 攻击文本末尾追加 (倍率xx%)', async () => {
    await freshMap();
    const uid = await makePlayer(1);
    await setupDummyMonster();
    jest.spyOn(combat as any, 'checkHit').mockReturnValue(true);

    const text = await attack(uid);
    expect(text.match(MULT_PATTERN)).not.toBeNull();
    // 原版 L3881：w2 = 显示攻击文本(...) + 显示伤害倍率(攻击方)
    expect(text).toMatch(HIT_LINE);
  });

  it('测试4 标记 bl=1 → 未命中/被闪避分支(L1561/L1698) 同样追加倍率', async () => {
    await freshMap();
    const uid = await makePlayer(1);
    await setupDummyMonster(100000); // 高闪避 → 真实命中判定必然失败

    // checkHit 含 5% 保底命中率(combat-system.service.ts L4629)，仅靠高闪避无法 100% 保证未命中，
    // 故显式 mock 为必不命中，使「未命中分支」确定性触发；同时禁用花园猫闪避反击递归
    // （怪物→玩家→怪物方向，见 handleGardenCatCounter），避免无限递归。
    jest.spyOn(combat as any, 'checkHit').mockReturnValue(false);
    jest.spyOn(combat as any, 'handleGardenCatCounter').mockResolvedValue('');

    const text = await attack(uid);
    expect(text).toMatch(MULT_PATTERN);
    // 未命中分支不产生伤害文本（原版 L1561/L1698 只追加特效与倍率），
    // 即倍率之后不会出现命中行的「... 目标，造成 ...」
    expect(text).not.toMatch(HIT_LINE);
  });

  it('测试5 设置面板指令可往返切换 bl，且切换后攻击文本同步生效', async () => {
    await freshMap();
    const uid = await makePlayer();
    // game.service.handleSettingsMultiplier（对应原版「设置倍率」指令）：开→bl=1，关→bl=0
    await gameService.handleSettingsMultiplier(uid);
    expect(parseJson((await playerService.getPlayerData(uid)).player.markers, {}).bl).toBe(1);

    await setupDummyMonster();
    jest.spyOn(combat as any, 'checkHit').mockReturnValue(true);
    expect(await attack(uid)).toMatch(MULT_PATTERN);

    await gameService.handleSettingsMultiplier(uid);
    expect(parseJson((await playerService.getPlayerData(uid)).player.markers, {}).bl).toBe(0);
    expect(await attack(uid)).not.toMatch(MULT_PATTERN);
  });
});
