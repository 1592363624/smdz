/**
 * 家园地面清理前置（开挖/建造地基）单元测试。
 *
 * 对应原版 _主程序.ecode L2516-2572：
 *  - 圈地时院子资源2 = [土堆, 杂草]（L2602-2605，资源列表1[3]/[4]）
 *  - 开挖地基：产出2为空的障碍物未清空时拦截（"必须先清空地面"）；清空后
 *    不消耗材料，进度→2，并把资源2重置为2个土堆（资源列表1[3]）
 *  - 建造地基：再次校验障碍物（"必须先挖开土堆"），随后逐项校验材料
 */
import { StaticDataService } from '../src/modules/game/static-data.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

describe('家园地面清理前置', () => {
  const staticData = new StaticDataService();

  const buildService = (player: any, yard: any) => {
    const service: any = Object.create(FamiliarSystemService.prototype);
    service.staticData = staticData;
    service.playerService = {
      safeJsonParse: jest.fn((value: any, fallback: any) => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(value); } catch { return fallback; }
      }),
      getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
      getBackpackItems: jest.fn((p: any) => JSON.parse(p.backpack || '[]')),
      savePlayer: jest.fn(async () => undefined),
      getPlayerData: jest.fn(async () => ({ player, markers: JSON.parse(player.markers || '{}') })),
    };
    service.mapService = {
      ensureHouseMaps: jest.fn(async () => ({ yard })),
      getMapById: jest.fn(async () => ({ id: yard.id, name: player.houseName })),
      updateDynamicFields: jest.fn(async (_id: number, fields: any) => Object.assign(yard, fields)),
    };
    service.taskService = { advance: jest.fn(async () => '') };
    return service;
  };

  const buildPlayer = (progress: number) => ({
    id: 1,
    name: '测试玩家',
    mapId: 9,
    houseName: '测试家园',
    stats: JSON.stringify({ 家园原地图ID: 3 }),
    markers: JSON.stringify({ 家园进度: progress }),
    backpack: JSON.stringify([
      { name: '木头', count: 80 },
      { name: '石头', count: 120 },
      { name: '铁矿', count: 40 },
      { name: '绳子', count: 40 },
    ]),
  });

  const moundDef = () => {
    const def = staticData.getAllResources().find((r: any) => r.name === '土堆');
    return JSON.parse(JSON.stringify(def));
  };

  it('开挖地基被未清理的土堆/杂草拦截，不消耗材料也不推进进度', async () => {
    const player = buildPlayer(1);
    const yard: any = {
      id: 9,
      resources2: JSON.stringify([moundDef(), { name: '杂草', times: 20, gatherCmd: '割草', outputs2: '[]' }]),
    };
    const service = buildService(player, yard);

    const result = await service.handleHome(1, '开挖地基');

    expect(result).toContain('必须先清空地面');
    expect(result).toContain('挖土');
    expect(result).toContain('割草');
    expect(JSON.parse(player.markers)['家园进度']).toBe(1);
    expect(JSON.parse(player.backpack).find((i: any) => i.name === '木头').count).toBe(80);
    expect(service.mapService.updateDynamicFields).not.toHaveBeenCalled();
  });

  it('地面清空后开挖地基不消耗材料，进度→2且资源2重置为2个土堆', async () => {
    const player = buildPlayer(1);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    const result = await service.handleHome(1, '开挖地基');

    expect(result).toContain('开始挖地基');
    expect(JSON.parse(player.markers)['家园进度']).toBe(2);
    const backpack = JSON.parse(player.backpack);
    expect(backpack.find((i: any) => i.name === '木头').count).toBe(80);

    const resources2 = JSON.parse(yard.resources2);
    expect(resources2).toHaveLength(2);
    for (const entry of resources2) {
      expect(entry.name).toBe('土堆');
      expect(entry.gatherCmd).toBe('挖土');
      expect(entry.times).toBe(20);
      expect(JSON.parse(entry.outputs2)).toEqual([]);
    }
    expect(service.taskService.advance).toHaveBeenCalledWith(1, '开挖地基');
  });

  it('开挖地基后新出现的土堆会再次拦截建造地基', async () => {
    const player = buildPlayer(1);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    // 先开挖一次（进度1→2），重置出2个土堆
    const dug = await service.handleHome(1, '开挖地基');
    expect(dug).toContain('开始挖地基');

    // 进度2时再发送建造地基：应被新土堆拦截
    const result = await service.handleHome(1, '建造地基');
    expect(result).toContain('必须先挖开土堆');
    expect(JSON.parse(player.markers)['家园进度']).toBe(2);
    expect(JSON.parse(player.backpack).find((i: any) => i.name === '木头').count).toBe(80);
    expect(JSON.parse(yard.resources2)).toHaveLength(2);
  });

  it('土堆清空后建造地基通过并消耗材料', async () => {
    const player = buildPlayer(2);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    const result = await service.handleHome(1, '建造地基');

    expect(result).toContain('地基已经建造好了');
    expect(JSON.parse(player.markers)['家园进度']).toBe(3);
    const backpack = JSON.parse(player.backpack);
    expect(backpack.find((i: any) => i.name === '木头')).toBeUndefined();
    expect(backpack.find((i: any) => i.name === '绳子')).toBeUndefined();
    expect(service.taskService.advance).toHaveBeenCalledWith(1, '建造地基');
  });

  it('材料不足时建造地基按原版逐项提示', async () => {
    const player = buildPlayer(2);
    player.backpack = JSON.stringify([{ name: '木头', count: 50 }]);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    const result = await service.handleHome(1, '建造地基');

    expect(result).toContain('建造地基需要80木头，你只有50');
    expect(JSON.parse(player.markers)['家园进度']).toBe(2);
  });
});
