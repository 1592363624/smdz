import { createGameServiceStub } from './helpers/game-service-stub.factory';
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
    // 背包条目数量只读规范键 quantity（count 旧镜像已废弃）
    const backpack: any[] = [{ name: '苹果树种子', quantity: 2 }];
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
    // 分阶段成熟玩法：每粒种子写入独立作物条目（不再按名称+数量聚合），
    // 两粒种子 → 两条同名"苹果树"，各自独立成熟
    expect(crops).toHaveLength(2);
    expect(crops.every((crop) => crop.name === '苹果树')).toBe(true);
    expect(Array.isArray(crops[0].outputs2)).toBe(true);
  });

  it('小数残余种子不足 1 时不得再种，也不得被整条抹掉', async () => {
    const map: any = { buildings: '[]', resources2: '[]' };
    // 生产/交易可能产生 2.27 这类小数种子；第 3 次种植旧逻辑会把 0.27 当整颗 splice
    const backpack: any[] = [{ name: '苹果树种子', quantity: 2.27 }];
    const service = new HomeService(
      {} as any,
      {} as any,
      {} as any,
      new StaticDataService(),
    );

    const first = await service.plantSeed(map, '苹果树种子', backpack, []);
    const second = await service.plantSeed(map, '苹果树种子', backpack, []);
    const third = await service.plantSeed(map, '苹果树种子', backpack, []);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(third.success).toBe(false);
    expect(parseJson(map.resources2, [])).toHaveLength(2);
    // 0.27 残余必须保留在背包，不能被当整颗扣掉
    expect(backpack).toEqual([{ name: '苹果树种子', quantity: 0.27 }]);
  });

  it('收获resources2作物时从资源定义outputs发放正向产出', async () => {
    const map: any = { buildings: '[]', resources2: '[]' };
    const staticData = new StaticDataService();
    // 背包条目数量只读规范键 quantity（count 旧镜像已废弃）
    const backpack: any[] = [{ name: '强壮苹果树种子', quantity: 1 }];
    const service = new HomeService(
      {} as any,
      {} as any,
      {} as any,
      staticData,
    );

    await service.plantSeed(map, '强壮苹果树种子', backpack, []);
    // 分阶段成熟玩法：刚种下的作物未成熟；把 plantedAt 置 0 模拟已成熟条目
    // （harvestCrop 对无/零 plantedAt 的旧存档条目按已成熟处理）
    parseJson(map.resources2, [])[0].plantedAt = 0;
    const result = await service.harvestCrop(map, '强壮苹果树', [], backpack);

    expect(result.success).toBe(true);
    expect(parseJson(map.resources2, [])).toEqual([]);
    // 收益 = 产出2正收益 × 棵数 × 总成熟秒数 / 600（每分钟口径折算整周期）
    const plan: any = (service as any).getCropGrowthPlan('强壮苹果树');
    const baseFruit = staticData.getAllResources()
      .find((r: any) => r.name === '强壮苹果树')
      .outputs2.find((o: any) => o.name === '果实').quantity;
    expect(backpack.find((item) => item.name === '果实')?.quantity)
      .toBeCloseTo(baseFruit * plan.totalSeconds / plan.rewardScaleDivisor, 6);
    expect(backpack.find((item) => item.name === '木头')).toBeUndefined();
  });

  it('使用种子直接进入当前家园种植闭环并推进种植任务', async () => {
    const staticData = new StaticDataService();
    const map: any = { id: 9, name: '测试家园', buildings: '[]', resources2: '[]' };
    // markers 带 家园进度=4：家园写操作（使用种子种植）要求房子已建成
    const player: any = {
      id: 7,
      name: '测试玩家',
      mapId: 9,
      houseName: '测试家园',
      backpack: '[]',
      markers: { 家园进度: 4 },
    };
    const backpack: any[] = [{ name: '苹果树种子', quantity: 1 }];
    const homeService = new HomeService({} as any, {} as any, {} as any, staticData);
    const service: any = createGameServiceStub();
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
