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
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { GameService } from '../src/modules/game/game.service';
import { MapService } from '../src/modules/game/map.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(180000);

describe('家园动态地图与前线攻势（真实数据库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let playerService: PlayerService;
  let mapService: MapService;
  let familiar: FamiliarSystemService;
  let game: GameService;
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
    expect(JSON.parse(player!.stats)).toHaveProperty('家园原地图ID');

    const yard = await mapService.getMapByName(houseName);
    expect(yard.isFrontier).toBe(true);
    expect(JSON.parse(yard.connections)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: expect.any(String), distance: 10 })]),
    );

    // 原版圈地：院子资源2 = [土堆, 杂草]，必须先「挖土」「割草」清空才能「开挖地基」
    const yardResources2 = JSON.parse(yard.resources2);
    expect(yardResources2.map((r: any) => r.name)).toEqual(['土堆', '杂草']);
    expect(yardResources2.every((r: any) => r.gatherCmd && r.times > 0)).toBe(true);

    const markers = { '家园进度': 4, 前线: 0 };
    await prisma.player.update({
      where: { userId },
      data: { markers: JSON.stringify(markers) },
    });
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
    let summons = JSON.parse(frontline.summons);
    const frontlineSummon = summons.find((item: any) => item.QQ?.startsWith('怪物前线'));
    expect(frontlineSummon).toBeDefined();
    frontlineSummon.当前生命 = 0.5;
    await mapService.updateDynamicFields(frontline.id, { summons: JSON.stringify(summons) });

    await familiar.handleHome(userId, '家园前线');
    frontline = await mapService.getMapByName(`${houseName}前线`);
    summons = JSON.parse(frontline.summons);
    const retained = summons.find((item: any) => item.QQ?.startsWith('怪物前线'));
    expect(retained.当前生命).toBe(0.5);
  });

  it.each([
    [0, 2, ['地精', '地精']],
    [15, 3, ['地精', '地精', '地精十夫长']],
    [40, 4, ['地精', '地精', '地精十夫长', '地精百夫长']],
    [60, 5, ['地精', '地精', '地精十夫长', '地精百夫长', '地精千夫长']],
  ])('前线等级%s按原版分支生成%s只地精', async (level, expectedCount, expectedNames) => {
    const frontline = await mapService.getMapByName(`${houseName}前线`);
    await mapService.clearMapMonsters(frontline.id);
    const playerData = await playerService.getPlayerData(userId);
    const markers = playerData.markers;
    markers['家园进度'] = 4;
    markers['前线'] = level;
    playerData.player.markers = markers;
    await playerService.savePlayer(playerData.player);

    const result = await game.handleStartBattle(userId);
    expect(result).toContain('地精的攻势开始了');

    const monsters = await mapService.getMapMonsters(frontline.id);
    expect(monsters).toHaveLength(expectedCount);
    expect(monsters.map((monster: any) => monster.name)).toEqual(expectedNames);
  });
});
