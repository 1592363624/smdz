/**
 * 家园地面清理前置（开挖/建造地基）单元测试。
 *
 * 对应原版 _主程序.ecode L2516-2572、L2447-2520：
 *  - 圈地时院子资源2 = [土堆, 杂草]（L2602-2605，资源列表1[3]/[4]）
 *  - 开挖地基：产出2为空的障碍物未清空时拦截（"必须先清空地面"）；清空后
 *    不消耗材料，进度→2，并把资源2重置为2个土堆（资源列表1[3]）
 *  - 建造地基：再次校验障碍物（"必须先挖开土堆"），随后逐项校验材料，
 *    成功后挂60秒「工作」标记（L2580），经验与完工播报延迟到延时结算发放
 *    （偏离原版的优化：原版开工瞬间即播报"完成"，已与需求方确认改为开工+完工两段）
 *  - 建造房子：成功后挂120秒「工作」标记（L2489），经验与完工播报延迟到延时结算发放
 */
import { StaticDataService } from '../src/modules/game/static-data.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { parseJson } from './parse-json.util';

describe('家园地面清理前置', () => {
  const staticData = new StaticDataService();

  const buildService = (player: any, yard: any) => {
    const service: any = Object.create(FamiliarSystemService.prototype);
    service.staticData = staticData;
    service.combatState = new CombatStateService();
    service.combatSystem = {
      actionUnrestricted: jest.fn(() => ({ restricted: false, text: '' })),
    };
    service.playerService = {
      safeJsonParse: jest.fn((value: any, fallback: any) => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(value); } catch { return fallback; }
      }),
      getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
      getBackpackItems: jest.fn((p: any) => parseJson(p.backpack, [])),
      savePlayer: jest.fn(async () => undefined),
      addExp: jest.fn(async () => ({ leveledUp: false, newLevel: 1 })),
      getPlayerData: jest.fn(async () => ({ player, markers: parseJson(player.markers, {}) })),
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => any) => fn()),
    };
    service.mapService = {
      ensureHouseMaps: jest.fn(async () => ({ yard })),
      getMapById: jest.fn(async () => ({ id: yard.id, name: player.houseName })),
      updateDynamicFields: jest.fn(async (_id: number, fields: any) => Object.assign(yard, fields)),
    };
    service.taskService = { advance: jest.fn(async () => '') };
    service.delayedTaskService = { schedule: jest.fn(async () => undefined) };
    return service;
  };

  const buildPlayer = (progress: number) => ({
    id: 1,
    name: '测试玩家',
    mapId: 9,
    houseName: '测试家园',
    stats: JSON.stringify({ 家园原地图ID: 3 }),
    markers: JSON.stringify({ 家园进度: progress }),
    markers2: '[]',
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
    expect(parseJson(player.markers, {})['家园进度']).toBe(1);
    expect(parseJson(player.backpack, []).find((i: any) => i.name === '木头').count).toBe(80);
    expect(service.mapService.updateDynamicFields).not.toHaveBeenCalled();
  });

  it('地面清空后开挖地基不消耗材料，进度→2且资源2重置为2个土堆', async () => {
    const player = buildPlayer(1);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    const result = await service.handleHome(1, '开挖地基');

    expect(result).toContain('开始挖地基');
    expect(parseJson(player.markers, {})['家园进度']).toBe(2);
    const backpack = parseJson(player.backpack, []);
    expect(backpack.find((i: any) => i.name === '木头').count).toBe(80);

    const resources2 = parseJson(yard.resources2, []);
    expect(resources2).toHaveLength(2);
    for (const entry of resources2) {
      expect(entry.name).toBe('土堆');
      expect(entry.gatherCmd).toBe('挖土');
      expect(entry.times).toBe(20);
      expect(parseJson(entry.outputs2, [])).toEqual([]);
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
    expect(parseJson(player.markers, {})['家园进度']).toBe(2);
    expect(parseJson(player.backpack, []).find((i: any) => i.name === '木头').count).toBe(80);
    expect(parseJson(yard.resources2, [])).toHaveLength(2);
  });

  it('土堆清空后建造地基通过：消耗材料、开工提示、挂60秒工作标记，延时到期结算经验与完工播报', async () => {
    const player = buildPlayer(2);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);
    const before = Date.now();

    const result = await service.handleHome(1, '建造地基');

    // 开工即返回提示（不再提前播报"完成"），经验/任务推迟到延时结算
    expect(result).toContain('开始了地基的建造，需要1分钟');
    expect(parseJson(player.markers, {})['家园进度']).toBe(3);
    expect(parseJson(player.markers, {})['地基结算待发']).toBe(1);
    const backpack = parseJson(player.backpack, []);
    expect(backpack.find((i: any) => i.name === '木头')).toBeUndefined();
    expect(backpack.find((i: any) => i.name === '绳子')).toBeUndefined();
    expect(service.playerService.addExp).not.toHaveBeenCalled();
    expect(service.taskService.advance).not.toHaveBeenCalled();
    // 排程60秒完工延时任务
    expect(service.delayedTaskService.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'homeFoundation', userId: 1 }),
    );
    const runAt = service.delayedTaskService.schedule.mock.calls[0][0].runAt;
    expect(runAt).toBeGreaterThanOrEqual(before + 60 * 1000);

    const markers2 = parseJson(player.markers2, []);
    const work = markers2.find((m: any) => (m.name ?? m.名称) === '工作');
    expect(work).toBeDefined();
    expect(work.有效期至 ?? work.expireAt).toBeGreaterThanOrEqual(before + 60 * 1000);
    expect(work.有效期至 ?? work.expireAt).toBeLessThanOrEqual(Date.now() + 60 * 1000 + 50);

    // 延时到期结算：认领标记、发放经验、推进任务并返回完工播报文本
    const settleText = await service.settleHomeFoundation(1);
    expect(settleText).toContain('花费1分钟完成了地基的建造，得到了200经验');
    expect(settleText).toContain('接下来「建造房子」');
    expect(service.playerService.addExp).toHaveBeenCalledWith(1, 200);
    expect(service.taskService.advance).toHaveBeenCalledWith(1, '建造地基');
    expect(parseJson(player.markers, {})['地基结算待发']).toBeUndefined();
    // 幂等：重复结算不二次发放
    const again = await service.settleHomeFoundation(1);
    expect(again).toBe('');
    expect(service.playerService.addExp).toHaveBeenCalledTimes(1);
  });

  it('行动受限（采集中/工作中）时建造地基被拦截且不扣材料', async () => {
    const player = buildPlayer(2);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);
    service.combatSystem.actionUnrestricted = jest.fn(() => ({ restricted: true, text: '测试玩家 采集中，还需要 30 秒' }));

    const result = await service.handleHome(1, '建造地基');

    expect(result).toContain('采集中');
    expect(parseJson(player.markers, {})['家园进度']).toBe(2);
    expect(parseJson(player.backpack, []).find((i: any) => i.name === '木头').count).toBe(80);
  });

  it('建造房子成功：消耗材料、开工提示、挂120秒工作标记、进度→4，延时到期结算经验与完工播报', async () => {
    const player = buildPlayer(3);
    player.backpack = JSON.stringify([
      { name: '木头', count: 300 },
      { name: '石头', count: 500 },
      { name: '铁矿', count: 160 },
      { name: '绳子', count: 120 },
    ]);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);
    const before = Date.now();

    const result = await service.handleHome(1, '建造房子');

    // 开工即返回提示（不再提前播报"完成"），经验/任务推迟到延时结算
    expect(result).toContain('开始了房子的建造，需要2分钟');
    expect(parseJson(player.markers, {})['家园进度']).toBe(4);
    expect(parseJson(player.markers, {})['房子结算待发']).toBe(1);
    const backpack = parseJson(player.backpack, []);
    expect(backpack).toEqual([]);
    expect(service.playerService.addExp).not.toHaveBeenCalled();
    expect(service.mapService.ensureHouseMaps).toHaveBeenCalledWith('测试家园', 3, 4);
    // 排程120秒完工延时任务
    expect(service.delayedTaskService.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'homeConstruct', userId: 1 }),
    );
    const markers2 = parseJson(player.markers2, []);
    const work = markers2.find((m: any) => (m.name ?? m.名称) === '工作');
    expect(work.有效期至 ?? work.expireAt).toBeGreaterThanOrEqual(before + 120 * 1000);

    // 延时到期结算：认领标记、发放经验、推进任务并返回完工播报文本
    const settleText = await service.settleHomeConstruct(1);
    expect(settleText).toContain('花费2分钟完成了房子的建造，得到了500经验');
    expect(settleText).toContain('🏠 家园建好了！');
    expect(service.playerService.addExp).toHaveBeenCalledWith(1, 500);
    expect(service.taskService.advance).toHaveBeenCalledWith(1, '建造房子');
    expect(parseJson(player.markers, {})['房子结算待发']).toBeUndefined();
  });

  it('材料不足时建造地基按原版逐项提示', async () => {
    const player = buildPlayer(2);
    player.backpack = JSON.stringify([{ name: '木头', count: 50 }]);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    const result = await service.handleHome(1, '建造地基');

    expect(result).toContain('建造地基需要80木头，你只有50');
    expect(parseJson(player.markers, {})['家园进度']).toBe(2);
  });

  it('建造地基倒计时期间重发指令提示剩余时间而非"已完成"', async () => {
    const player = buildPlayer(2);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    await service.handleHome(1, '建造地基');
    const again = await service.handleHome(1, '建造地基');

    expect(again).toContain('家园正在建造中');
    expect(again).toMatch(/还需要\d+秒/);
  });

  it('建造房子倒计时期间重发指令提示剩余时间而非"已建好"', async () => {
    const player = buildPlayer(3);
    player.backpack = JSON.stringify([
      { name: '木头', count: 300 },
      { name: '石头', count: 500 },
      { name: '铁矿', count: 160 },
      { name: '绳子', count: 120 },
    ]);
    const yard: any = { id: 9, resources2: '[]' };
    const service = buildService(player, yard);

    await service.handleHome(1, '建造房子');
    const again = await service.handleHome(1, '建造房子');

    expect(again).toContain('家园正在建造中');
    expect(again).toMatch(/还需要\d+秒/);
    // 倒计时期间经验不应已发放
    expect(service.playerService.addExp).not.toHaveBeenCalled();
  });
});
