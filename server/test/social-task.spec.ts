import { GameService } from '../src/modules/game/game.service';

function jsonParse(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

describe('贸易、购物、求助任务触发', () => {
  it('市场贸易成功后只推进一次贸易任务', async () => {
    const taskService = { advance: jest.fn(async () => '') };
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({
        player: { userId: 42, name: '冒险者', backpack: '[]' },
      })),
      getBackpackItems: jest.fn(() => [{ name: '木头', count: 2 }]),
      removeFromBackpack: jest.fn(async () => true),
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ qqNumber: 'qq-42' })) },
      gameShopItem: { create: jest.fn(async () => ({ id: 1 })) },
    };
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma,
      playerService,
      taskService,
      logger: { log: jest.fn() },
    });

    const result = await service.handleTrade(42, '上架', ['木头', '10']);

    expect(result).toContain('成功上架');
    expect(taskService.advance).toHaveBeenCalledTimes(1);
    expect(taskService.advance).toHaveBeenCalledWith(42, '贸易');
  });

  it('行商购买成功后推进一次购物任务', async () => {
    const player: any = {
      userId: 42,
      name: '冒险者',
      mapId: 7,
      level: 1,
      houseName: '',
      markers: '{}',
      markers2: '[]',
      backpack: JSON.stringify([
        { name: '木头', count: 1000 },
        { name: '石头', count: 1000 },
        { name: '绳子', count: 1000 },
        { name: '铁矿', count: 1000 },
      ]),
    };
    const map: any = {
      id: 7,
      name: '测试地图',
      isFrontier: false,
      summons: JSON.stringify([{
        name: '行商',
        backpack: JSON.stringify([{ name: '商品', type: '资源', quantity: 1 }]),
      }]),
    };
    const markers: Record<string, any> = {};
    const taskService = { advance: jest.fn(async () => '') };
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({ player, markers })),
      isPlayerDead: jest.fn(() => false),
      getBackpackItems: jest.fn((current: any) => jsonParse(current.backpack, [])),
      safeJsonParse: jest.fn(jsonParse),
      savePlayer: jest.fn(async () => undefined),
    };
    const mapService: any = {
      getMapById: jest.fn(async () => map),
      getMapByName: jest.fn(async () => null),
      updateDynamicFields: jest.fn(async (_mapId: number, data: any) => Object.assign(map, data)),
    };
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma: { player: { findUnique: jest.fn(async () => player) } },
      playerService,
      mapService,
      taskService,
      achievementService: {
        getAchievement: jest.fn(() => 0),
        setAchievement: jest.fn((target: any, name: string, value: number) => { target[name] = value; }),
      },
      staticData: {},
      itemService: { parseEquipment: jest.fn() },
      logger: { log: jest.fn() },
    });

    const result = await service.handleShop(42, '购买', ['1']);

    expect(result).toContain('购买了');
    expect(taskService.advance).toHaveBeenCalledTimes(1);
    expect(taskService.advance).toHaveBeenCalledWith(42, '购物');
  });

  it('向露娜确认求助成功后推进求助任务，普通求助文本不推进', async () => {
    const player: any = {
      userId: 42,
      name: '冒险者',
      mapId: 7,
      markers: '{}',
    };
    const map: any = {
      id: 7,
      summons: JSON.stringify([{ qq: '怪物露娜1g', ownerQQ: '1' }]),
    };
    const markers: Record<string, any> = {};
    const taskService = { advance: jest.fn(async () => '') };
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({ player, markers })),
      isPlayerDead: jest.fn(() => false),
      safeJsonParse: jest.fn(jsonParse),
      setMarker: jest.fn((target: any, name: string, value: number) => { target[name] = value; }),
      savePlayer: jest.fn(async () => undefined),
    };
    const prisma: any = {
      player: { findUnique: jest.fn(async () => player) },
      gameMap: {
        update: jest.fn(async ({ data }: any) => Object.assign(map, data)),
      },
    };
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma,
      playerService,
      taskService,
      mapService: { getMapById: jest.fn(async () => map) },
      logger: { log: jest.fn() },
    });

    const result = await service.handleConfirmHelp(42, '');

    expect(result).toContain('从现在开始');
    expect(taskService.advance).toHaveBeenCalledTimes(1);
    expect(taskService.advance).toHaveBeenCalledWith(42, '求助');
  });
});
