/**
 * 行商系统端到端回归测试（真实数据库）。
 *
 * 原文对照：
 * - _主程序.ecode L5819-5973：呼叫、通讯台、免费时段、发带呼叫。
 * - _主程序.ecode L9892-10088：行商列表、购买、购买冷却、自动购物。
 * - 后台运作.ecode L1471-1528：库存数量、装备品质和额外资源。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GameService } from '../src/modules/game/game.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { MapService } from '../src/modules/game/map.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseJson } from './parse-json.util';

jest.setTimeout(180000);

describe('行商迁移（真实数据库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let game: GameService;
  let familiarSystem: FamiliarSystemService;
  let mapService: MapService;
  let playerService: PlayerService;
  let userId = 0;
  let mapId = 0;
  let originalBuildings = '[]';
  let originalSummons = '[]';

  const stamp = () => Math.random().toString(36).slice(2, 9);

  async function readPlayer() {
    return playerService.getPlayerData(userId);
  }

  async function setPlayer(data: Record<string, any>) {
    const pd = await readPlayer();
    Object.assign(pd.player, data);
    await playerService.savePlayer(pd.player);
  }

  async function setMerchant(items: any[]) {
    const map = await mapService.getMapById(mapId);
    const summons = playerService.safeJsonParse<any[]>(map.summons, [])
      .filter((summon: any) => (summon.name ?? summon.名称) !== '行商');
    summons.push({
      name: '行商',
      type: '行商',
      ownerQQ: '',
      qq: `merchant_test_${stamp()}`,
      level: 1,
      backpack: JSON.stringify(items),
      markers: '{}',
      markers2: '[]',
      buffs: '[]',
    });
    await mapService.updateDynamicFields(mapId, { summons: JSON.stringify(summons) });
  }

  async function merchantFromMap() {
    const map = await mapService.getMapById(mapId);
    const summons = playerService.safeJsonParse<any[]>(map.summons, []);
    return summons.find((summon: any) => (summon.name ?? summon.名称) === '行商');
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    game = app.get(GameService);
    familiarSystem = app.get(FamiliarSystemService);
    mapService = app.get(MapService);
    playerService = app.get(PlayerService);

    const startMap = (await mapService.getAllMaps()).find((map: any) => !map.isInstance && !map.isFrontier);
    mapId = startMap.id;
    const snapshot = await mapService.getMapById(mapId);
    originalBuildings = snapshot.buildings;
    originalSummons = snapshot.summons;

    const user = await prisma.user.create({
      data: { username: `e2e_merchant_${stamp()}`, password: 'e2e_test', role: 'USER' },
    });
    userId = user.id;
    await prisma.player.create({
      data: {
        userId,
        mapId,
        location: startMap.name,
        houseName: startMap.name,
        name: '端到端行商测试',
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

    await mapService.updateDynamicFields(mapId, {
      buildings: JSON.stringify([{ name: '通讯台', type: '建筑', quantity: 1 }]),
      summons: JSON.stringify([]),
    });
  });

  afterAll(async () => {
    try {
      if (mapId) {
        await mapService.updateDynamicFields(mapId, {
          buildings: originalBuildings,
          summons: originalSummons,
        });
      }
      if (userId) await prisma.user.delete({ where: { id: userId } });
    } finally {
      if (app) await app.close();
    }
  });

  it('设置购物按原版校验危险字符，并将等号替换为文本', async () => {
    const invalid = await game.handleSettingsShop(userId, '工业%');
    expect(invalid).toContain('不能包含%');

    const result = await game.handleSettingsShop(userId, '工业=窝');
    expect(result).toContain('工业【等号】窝');
    const player = await prisma.player.findUnique({ where: { userId } });
    expect(parseJson(player!.markers, {})['自动购物']).toBe('工业【等号】窝');
  });

  it('通讯台免费呼叫行商，生成原版默认六件库存并写入当日通讯冷却', async () => {
    await setPlayer({
      houseName: (await mapService.getMapById(mapId)).name,
      markers2: '[]',
      backpack: '[]',
    });
    const result = await game.handleCallVehicle(userId, '行商');
    expect(result).toContain('行商来到了');

    const merchant = await merchantFromMap();
    const inventory = parseJson(merchant.backpack, []);
    expect(inventory).toHaveLength(6);
    expect(inventory.slice(0, 3).every((item: any) => item.type === '装备')).toBe(true);
    expect(inventory.slice(3).every((item: any) => item.type === '资源')).toBe(true);

    const player = await prisma.player.findUnique({ where: { userId } });
    const markers2 = parseJson(player!.markers2, []);
    expect(markers2.some((marker: any) => (marker.name ?? marker.名称).startsWith('通讯'))).toBe(true);
  });

  it('没有通讯台时拒绝呼叫行商', async () => {
    await mapService.updateDynamicFields(mapId, { buildings: JSON.stringify([]) });
    const result = await game.handleCallVehicle(userId, '行商');
    expect(result).toBe('端到端行商测试需要建筑【通讯台】');
    await mapService.updateDynamicFields(mapId, {
      buildings: JSON.stringify([{ name: '通讯台', type: '建筑', quantity: 1 }]),
    });
  });

  it('免费时段已使用后，发带呼叫按原版等级上限生成库存', async () => {
    const player = await prisma.player.findUnique({ where: { userId } });
    await setPlayer({
      markers2: player!.markers2,
      backpack: JSON.stringify([{ name: '发带', type: '资源', quantity: 5 }]),
    });

    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const result = await game.handleCallVehicle(userId, '行商');
      expect(result).toContain('消耗发带4');
      const merchant = await merchantFromMap();
      expect(parseJson(merchant.backpack, [])).toHaveLength(24);
      const after = await prisma.player.findUnique({ where: { userId } });
      expect(parseJson(after!.backpack, [])).toEqual([
        { name: '发带', type: '资源', quantity: 1 },
      ]);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('普通购物按等级和好感公式扣除资源并移除库存', async () => {
    await setMerchant([{ name: '测试资源', type: '资源', quantity: 2, data: '' }]);
    await setPlayer({
      markers: JSON.stringify({}),
      markers2: '[]',
      backpack: JSON.stringify([
        { name: '木头', type: '资源', quantity: 100 },
        { name: '石头', type: '资源', quantity: 100 },
        { name: '绳子', type: '资源', quantity: 100 },
        { name: '铁矿', type: '资源', quantity: 100 },
      ]),
    });

    const result = await game.handleShop(userId, '1', []);
    expect(result).toContain('从行商处购买了测试资源x2');
    const player = await prisma.player.findUnique({ where: { userId } });
    const backpack = parseJson(player!.backpack, []);
    expect(backpack.find((item: any) => item.name === '木头').quantity).toBe(50);
    expect(backpack.find((item: any) => item.name === '石头').quantity).toBe(60);
    expect(backpack.find((item: any) => item.name === '绳子').quantity).toBe(70);
    expect(backpack.find((item: any) => item.name === '铁矿').quantity).toBe(70);
    expect(backpack.find((item: any) => item.name === '测试资源').quantity).toBe(2);
    const merchant = await merchantFromMap();
    expect(parseJson(merchant.backpack, [])).toEqual([]);
  });

  it('资源不足时不消耗资源、不移除商品，并保留原版购买失败提示', async () => {
    await setMerchant([{ name: '测试资源', type: '资源', quantity: 1, data: '' }]);
    await setPlayer({ markers2: '[]', backpack: '[]' });

    const result = await game.handleShop(userId, '1', []);
    expect(result).toContain('需要木头x50');
    const merchant = await merchantFromMap();
    expect(parseJson(merchant.backpack, [])).toHaveLength(1);
    const player = await prisma.player.findUnique({ where: { userId } });
    expect(parseJson(player!.backpack, [])).toEqual([]);
  });

  it('自动购物倒序购买匹配商品，第二件资源不足时停止并提示', async () => {
    await setMerchant([
      { name: '工业熔炉', type: '资源', quantity: 1, data: '' },
      { name: '狐狸窝', type: '资源', quantity: 1, data: '' },
      { name: '不匹配', type: '资源', quantity: 1, data: '' },
    ]);
    await setPlayer({
      markers: JSON.stringify({ 自动购物: '工业、窝' }),
      markers2: '[]',
      backpack: JSON.stringify([
        { name: '木头', type: '资源', quantity: 50 },
        { name: '石头', type: '资源', quantity: 40 },
        { name: '绳子', type: '资源', quantity: 30 },
        { name: '铁矿', type: '资源', quantity: 30 },
      ]),
    });
    const playerBefore = await prisma.player.findUnique({ where: { userId } });
    expect(parseJson(playerBefore!.markers, {})['自动购物']).toBe('工业、窝');
    const merchantBefore = parseJson((await mapService.getMapById(mapId)).summons, [])
      .find((item: any) => item.name === '行商');
    expect(merchantBefore).toBeDefined();
    expect((game as any).formatMerchantItem(parseJson(merchantBefore.backpack, [])[1], true)).toContain('狐狸窝');
    const playerDataBefore = await readPlayer();
    expect((game as any).hasEnoughResources(playerDataBefore.backpack, [
      { name: '木头', quantity: 50 },
      { name: '石头', quantity: 40 },
      { name: '绳子', quantity: 30 },
      { name: '铁矿', quantity: 30 },
    ])).toBe(true);

    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const result = await game.handleAutoShop(userId, '');
      expect(result).toContain('购买了狐狸窝x1');
      expect(result).toContain('有资源不足以购买全部匹配的物品');
    } finally {
      randomSpy.mockRestore();
    }

    const merchant = await merchantFromMap();
    const remaining = parseJson(merchant.backpack, []);
    expect(remaining.map((item: any) => item.name)).toEqual(['工业熔炉', '不匹配']);
    const player = await prisma.player.findUnique({ where: { userId } });
    const backpack = parseJson(player!.backpack, []);
    expect(backpack.find((item: any) => item.name === '狐狸窝').quantity).toBe(1);
  });

  it('按原版商店配置显示余额，并解析兑换名称后的次数', async () => {
    await setPlayer({
      markers: JSON.stringify({ 活跃度: 500, 兑换: 0 }),
      backpack: JSON.stringify([{ name: '钻石', quantity: 20 }, { name: '数据核心', count: 50 }]),
    });

    const activityShop = await familiarSystem.familiarShop(userId, 'activity');
    expect(activityShop).toContain('水晶箱(2)');
    expect(activityShop).toContain('优秀武器补给箱(100)');
    const diamondShop = await familiarSystem.familiarShop(userId, 'diamond');
    expect(diamondShop).toContain('你有20钻石');
    expect(diamondShop).toContain('水晶(2)');

    const result = await familiarSystem.exchange(userId, '优秀武器补给箱3', 1);
    expect(result).toContain('用300活跃度兑换了优秀武器补给箱x3');
    const after = await prisma.player.findUnique({ where: { userId } });
    const markers = parseJson(after!.markers, {});
    const backpack = parseJson(after!.backpack, []);
    expect(markers['活跃度']).toBe(200);
    expect(backpack.find((item: any) => item.name === '优秀武器补给箱').quantity).toBe(3);
  });

  it('兑换按活跃度、钻石、数据核心顺序匹配，并以quantity/count兼容余额', async () => {
    // P1 货币列化：货币真相源是列（读取时物化回背包）
    await setPlayer({
      markers: JSON.stringify({ 活跃度: 0 }),
      diamonds: 20,
      dataCores: 50,
    });

    const result = await familiarSystem.exchange(userId, '水晶', 1);
    expect(result).toContain('用2钻石兑换了水晶x1');
    const after = await prisma.player.findUnique({ where: { userId } });
    expect(after!.diamonds).toBe(18);

    const equipmentResult = await familiarSystem.exchange(userId, '纳米头盔', 1);
    expect(equipmentResult).toContain('用50数据核心兑换了纳米头盔');
    const final = await prisma.player.findUnique({ where: { userId } });
    const finalBackpack = parseJson(final!.backpack, []);
    expect(finalBackpack.some((item: any) => item.name === '纳米头盔' && item.type === '装备')).toBe(true);
    expect(finalBackpack.find((item: any) => item.name === '数据核心')).toBeUndefined();
  });
});
