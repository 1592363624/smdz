import { HomeService } from '../src/modules/game/home.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { GameService } from '../src/modules/game/game.service';

/** 兼容两种存储形态：Prisma Json 列/内存快照读出已是对象数组（权威），历史字符串兜底解析。 */
function parseJson(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

describe('家园作物种植与收获', () => {
  it('按种子useEffects映射资源，并写入resources2而不是buildings', async () => {
    const map: any = { buildings: '[]', resources2: '[]' };
    const backpack: any[] = [{ name: '苹果树种子', quantity: 2, count: 2 }];
    const service = new HomeService(
      {} as any,
      {} as any,
      {} as any,
      new StaticDataService(),
    );

    const first = await service.plantSeed(map, '苹果树种子', backpack, []);
    const second = await service.plantSeed(map, '苹果树种子', backpack, []);
    const crops = parseJson(map.resources2, []);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(parseJson(map.buildings, [])).toEqual([]);
    expect(backpack).toEqual([]);
    expect(crops).toHaveLength(1);
    expect(crops[0].name).toBe('苹果树');
    expect(crops[0].count).toBe(2);
    expect(Array.isArray(crops[0].outputs2)).toBe(true);
  });

  it('收获resources2作物时从资源定义outputs发放正向产出', async () => {
    const map: any = { buildings: '[]', resources2: '[]' };
    const backpack: any[] = [{ name: '强壮苹果树种子', quantity: 1, count: 1 }];
    const service = new HomeService(
      {} as any,
      {} as any,
      {} as any,
      new StaticDataService(),
    );

    await service.plantSeed(map, '强壮苹果树种子', backpack, []);
    const result = await service.harvestCrop(map, '强壮苹果树', [], backpack);

    expect(result.success).toBe(true);
    expect(parseJson(map.resources2, [])).toEqual([]);
    expect(backpack.find((item) => item.name === '果实')?.quantity).toBe(5);
    expect(backpack.find((item) => item.name === '木头')).toBeUndefined();
  });

  it('使用种子直接进入当前家园种植闭环并推进种植任务', async () => {
    const staticData = new StaticDataService();
    const map: any = { id: 9, name: '测试家园', buildings: '[]', resources2: '[]' };
    const player: any = { id: 7, name: '测试玩家', mapId: 9, houseName: '测试家园', backpack: '[]' };
    const backpack: any[] = [{ name: '苹果树种子', quantity: 1, count: 1 }];
    const homeService = new HomeService({} as any, {} as any, {} as any, staticData);
    const service: any = Object.create(GameService.prototype);
    service.staticData = staticData;
    service.homeService = homeService;
    service.itemService = { useItem: jest.fn() };
    service.playerService = {
      safeJsonParse: jest.fn((value: any, fallback: any) => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(value); } catch { return fallback; }
      }),
      getPlayerData: jest.fn(async () => ({ player, backpack })),
      savePlayer: jest.fn(async () => undefined),
    };
    service.mapService = {
      getMapById: jest.fn(async () => map),
      updateDynamicFields: jest.fn(async (_id: number, fields: any) => Object.assign(map, fields)),
    };
    service.taskService = { advance: jest.fn(async () => '') };

    const result = await service.handleUseItem(7, '苹果树种子', 1);
    const crops = parseJson(map.resources2, []);

    expect(result).toContain('苹果树×1');
    expect(crops[0].name).toBe('苹果树');
    expect(backpack).toEqual([]);
    expect(service.taskService.advance).toHaveBeenCalledWith(7, '种植', 1);
    expect(service.taskService.advance).toHaveBeenCalledWith(7, '种植苹果树', 1);
  });
});
