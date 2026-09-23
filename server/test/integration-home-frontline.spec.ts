/**
 * 家园动态地图与前线攻势端到端测试。
 *
 * 对应原版：
 *  - 接口1.ecode L1395-1480：院子/屋内/前线动态地图
 *  - _主程序.ecode L2077-2163：开始战斗的前线等级波次
 *  - _主程序.ecode L2228-2254：家园前线首次生成与状态展示
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { GameService } from '../src/modules/game/game.service';
import { MapService } from '../src/modules/game/map.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseJson } from './parse-json.util';
import { mutatePlayerState } from './actor-write.util';

jest.setTimeout(180000);

describe('家园动态地图与前线攻势（真实数据库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let playerService: PlayerService;
  let mapService: MapService;
  let familiar: FamiliarSystemService;
  let game: GameService;
  let combat: CombatSystemService;
  let userId = 0;
  let houseName = '';
  let dynamicMapIds: number[] = [];

  const stamp = () => Math.random().toString(36).slice(2, 9);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    playerService = app.get(PlayerService);
    mapService = app.get(MapService);
    familiar = app.get(FamiliarSystemService);
    game = app.get(GameService);
    combat = app.get(CombatSystemService);

    const startMap = (await mapService.getAllMaps()).find((map: any) => !map.isInstance && !map.isFrontier);
    const user = await prisma.user.create({
      data: { username: `e2e_home_front_${stamp()}`, password: 'e2e_test', role: 'USER' },
    });
    userId = user.id;
    await prisma.player.create({
      data: {
        userId,
        mapId: startMap.id,
        location: startMap.name,
        name: '端到端前线测试',
        hp: 100,
        maxHp: 100,
        markers: '{}',
        markers2: '[]',
        buffs: '[]',
        backpack: '[]',
        equipment: '[]',
        weapons: '[]',
        tasks: '[]',
      },
    });
  });

  afterAll(async () => {
    try {
      const maps = houseName
        ? await prisma.gameMap.findMany({ where: { name: { startsWith: houseName } }, select: { id: true } })
        : [];
      dynamicMapIds = maps.map((map) => map.id);
      if (dynamicMapIds.length > 0) {
        await prisma.gameMonster.deleteMany({ where: { mapId: { in: dynamicMapIds } } });
        await prisma.gameMap.deleteMany({ where: { id: { in: dynamicMapIds } } });
      }
      if (userId) await prisma.user.delete({ where: { id: userId } });
    } finally {
      if (app) await app.close();
    }
  });

  it('圈地创建院子，建成进度后补建屋内和前线地图', async () => {
    const claimed = await familiar.handleHome(userId, '圈地');
    expect(claimed).toContain('圈了一块地');

    const player = await prisma.player.findUnique({ where: { userId } });
    houseName = player?.houseName || '';
    expect(houseName).toBeTruthy();
    expect(player?.stats).toHaveProperty('家园原地图ID');

    const yard = await mapService.getMapByName(houseName);
    expect(yard.isFrontier).toBe(true);
    expect(parseJson(yard.connections, [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: expect.any(String), distance: 10 })]),
    );

    // 原版圈地：院子资源2 = [土堆, 杂草]，必须先「挖土」「割草」清空才能「开挖地基」
    const yardResources2 = parseJson(yard.resources2, []);
    expect(yardResources2.map((r: any) => r.name)).toEqual(['土堆', '杂草']);
    expect(yardResources2.every((r: any) => r.gatherCmd && r.times > 0)).toBe(true);

    // 家园进度置 4（可挖地基建屋内/前线）。经 Actor 漏斗改写，避免陈旧 cell
    // 回写覆盖（见 actor-write.util.ts）——裸 prisma.player.update 只改 DB 不改活态，
    // 后续 handleHome('家园前线') 复用陈旧 cell（家园进度=1）会把它回写，导致
    // handleStartBattle 误判「房屋未建成」。
    const markers = { '家园进度': 4, 前线: 0 };
    await mutatePlayerState(playerService, userId, (player) => { player.markers = markers; });
    const homePlayer = await prisma.player.findUnique({ where: { userId } });
    await mapService.ensureHouseMaps(houseName, homePlayer!.mapId, 4);
    const interior = await mapService.getMapByName(`${houseName}屋内`);
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    expect(interior.isFrontier).toBe(true);
    expect(frontline.isInstance).toBe(true);
  });

  it('首次查看生成前线，重复查看保留前线召唤物状态', async () => {
    const first = await familiar.handleHome(userId, '家园前线');
    expect(first).toContain('前线防御阵地');

    let frontline = await mapService.getMapByName(`${houseName}前线`);
    let summons = parseJson(frontline.summons, []);
    const frontlineSummon = summons.find((item: any) => item.QQ?.startsWith('怪物前线'));
    expect(frontlineSummon).toBeDefined();
    // 规范键 hp（中文「当前生命」已在边界收敛，见 field-contract SUMMON_ALIASES）
    frontlineSummon.hp = 0.5;
    // Json 列写回原生数组（生产已禁止 JSON.stringify 字符串落库）
    await mapService.updateDynamicFields(frontline.id, { summons });

    await familiar.handleHome(userId, '家园前线');
    frontline = await mapService.getMapByName(`${houseName}前线`);
    summons = parseJson(frontline.summons, []);
    const retained = summons.find((item: any) => item.QQ?.startsWith('怪物前线'));
    expect(retained.hp).toBe(0.5);
  });

  it.each([
    [1, 2, ['地精', '地精']],
    [15, 3, ['地精', '地精', '地精十夫长']],
    [40, 4, ['地精', '地精', '地精十夫长', '地精百夫长']],
    [60, 5, ['地精', '地精', '地精十夫长', '地精百夫长', '地精千夫长']],
  ])('前线等级%s按原版分支生成%s只地精', async (level, expectedCount, expectedNames) => {
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    await mapService.clearMapMonsters(frontline.id);
    const playerData = await playerService.getPlayerData(userId);
    const markers = playerData.markers;
    markers['家园进度'] = 4;
    // 前线等级是「前线熟练度」按平方阈值派生出来的（原版 显示熟练度等级），
    // 等级 L 的下界是 (L-1)²。直接写 markers['前线'] 已经不再生效。
    markers['前线熟练度'] = (Number(level) - 1) ** 2;
    playerData.player.markers = markers;
    await playerService.savePlayer(playerData.player);

    const result = await game.handleStartBattle(userId);
    expect(result).toContain('地精的攻势开始了');

    const monsters = await mapService.getMapMonsters(frontline.id);
    expect(monsters).toHaveLength(expectedCount);
    expect(monsters.map((monster: any) => monster.name)).toEqual(expectedNames);
  });

  it('战斗节拍打在真正的前线地图上：地精掉血、阵地存活、活动标记在窗口内', async () => {
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    await mapService.clearMapMonsters(frontline.id);
    const playerData = await playerService.getPlayerData(userId);
    playerData.markers['家园进度'] = 4;
    playerData.markers['前线熟练度'] = 0;
    playerData.player.markers = playerData.markers;
    await playerService.savePlayer(playerData.player);
    expect(await game.handleStartBattle(userId)).toContain('地精的攻势开始了');

    // 回归点：MapBattleLoopService 过去把 GameMap.mapIndex 当成 getAllMaps() 的
    // 1-based 下标传给 adminAttackMap，动态家园地图两者并不相等（实测前线
    // mapIndex=12、数组下标=95），整条循环于是跑到「居民区」上，前线地精一滴血不掉。
    const allMaps = await mapService.getAllMaps();
    const arrayIndexPlusOne = allMaps.findIndex((m: any) => m.id === frontline.id) + 1;
    expect(frontline.mapIndex).not.toBe(arrayIndexPlusOne);

    // 阵地必中，但每回合只出一只手且地图节拍有 2 秒节流，跑几回合保证命中
    const pool = async () => {
      const list = await mapService.getMapMonsters(frontline.id);
      return list.reduce(
        (s: number, m: any) => s + Number(m.hp || 0) + Number(m.shield || 0) + Number(m.armor || 0),
        0,
      );
    };
    const totalBefore = await pool();
    expect(totalBefore).toBeGreaterThan(0);

    let damaged = false;
    for (let round = 0; round < 4 && !damaged; round++) {
      if (round > 0) await new Promise((resolve) => setTimeout(resolve, 2200));
      await combat.adminAttackMapById(0, Number(frontline.id));
      damaged = (await pool()) < totalBefore;
    }
    expect(damaged).toBe(true);

    // 阵地（前线召唤物）必须真的在场上，否则火力通道是空的、玩家什么也看不到
    const refreshed = await mapService.getMapByName(`${houseName}前线`);
    const summons = parseJson(refreshed.summons, []);
    expect(summons.find((s: any) => s.QQ?.startsWith('怪物前线'))).toBeDefined();
    const markers2 = parseJson(refreshed.markers2, []);
    expect(
      markers2.some((g: any) => g.name === '活动' && Number(g.expireAt) > Date.now()),
    ).toBe(true);
  });

  it('阵地归属到真正的主人，不会把击杀记到别的玩家头上', async () => {
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    const summons = parseJson(frontline.summons, []);
    const position = summons.find((s: any) => s.QQ?.startsWith('怪物前线'));
    expect(position).toBeDefined();
    // 回归点：ownerQQ 在网页登录玩家身上退化成 String(userId)，而归属解析过去把
    // 纯数字当 Player.id 查。实测 userId=3 的阵地被解析成 Player.id=3 的另一名玩家
    // （userId=4），击杀记到别人头上，前线奖励判定「地图名==击杀者房子+前线」永不成立。
    expect(Number(position.ownerUserId)).toBe(userId);
    expect(await (combat as any).resolveSummonOwnerUserId(position, 0)).toBe(userId);
  });

  it('击杀地精发放前线熟练度、载具残骸与本波战报', async () => {
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    await mapService.clearMapMonsters(frontline.id);
    const playerData = await playerService.getPlayerData(userId);
    playerData.markers['家园进度'] = 4;
    playerData.markers['前线熟练度'] = 0;
    playerData.player.markers = playerData.markers;
    await playerService.savePlayer(playerData.player);
    expect(await game.handleStartBattle(userId)).toContain('地精的攻势开始了');

    const monsters = await mapService.getMapMonsters(frontline.id);
    const target = monsters[0];
    const fresh = await playerService.getPlayerData(userId);
    const frontlineText = await combat.handleMonsterDeath(target, userId, frontline.id, fresh, 'normal', '');

    expect(String(frontlineText.frontlineText)).toContain('前线熟练度+1');
    expect(String(frontlineText.frontlineText)).toContain('载具残骸');

    const data = await playerService.getPlayerData(userId);
    expect(Number(data.markers['前线熟练度']) || 0).toBe(1);

    const settled = await mapService.getMapByName(`${houseName}前线`);
    const resources2 = parseJson(settled.resources2, []);
    const wreckage = resources2.find((r: any) => r.name === '载具残骸');
    // 残骸必须带 gatherCmd/outputs，否则计数在涨但玩家「收集残骸」采不走
    expect(wreckage).toBeDefined();
    expect(wreckage.times).toBeGreaterThan(0);
    expect(wreckage.gatherCmd).toBe('收集残骸');
    expect(Array.isArray(wreckage.outputs) && wreckage.outputs.length > 0).toBe(true);

    const report = parseJson(settled.markers, {})['前线战报'];
    expect(report).toBeDefined();
    expect(report.kills).toBe(1);
    expect(report.proficiency).toBe(1);
    expect(report.wreckage).toBeGreaterThan(0);
    expect(report.byName['地精']).toBe(1);
    expect(report.result).toBe('');

    // 最后一只地精是在本回合的召唤物攻击里没掉的，下一回合读到空怪物数组就提前 return；
    // 少了这条收尾，已经清空的一波会永远显示「交战中」。
    await mapService.clearMapMonsters(frontline.id);
    await combat.adminAttackMapById(0, Number(frontline.id));
    const closed = parseJson((await mapService.getMapByName(`${houseName}前线`)).markers, {})['前线战报'];
    expect(closed.result).toBe('victory');
    expect(Number(closed.finishedAt)).toBeGreaterThan(0);
  });

  it('阵地丢失后「开始战斗」清残留重建阵地，不再永久卡死', async () => {
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    // 造出用户实测到的死局：地精满血挂在图上，但阵地召唤物已经没了
    await mapService.clearMapMonsters(frontline.id);
    await game.handleStartBattle(userId);
    await mapService.mutateMapFields(frontline.id, ['summons'], (f) => {
      f.summons = (f.summons || []).filter((s: any) => !String(s.QQ || s.qq).startsWith('怪物前线'));
      return true;
    });

    const stuck = await game.handleStartBattle(userId);
    expect(stuck).toContain('地精的攻势开始了');
    expect(stuck).toContain('重筑阵地');

    const monsters = await mapService.getMapMonsters(frontline.id);
    expect(monsters.length).toBeGreaterThan(0);
    const summons = parseJson((await mapService.getMapByName(`${houseName}前线`)).summons, []);
    expect(summons.find((s: any) => s.QQ?.startsWith('怪物前线'))).toBeDefined();
  });
});
