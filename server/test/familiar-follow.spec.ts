import { GameService } from '../src/modules/game/game.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

function parseJson(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeService() {
  const player: any = { id: 7, userId: 42, mapId: 1, name: '玩家' };
  const map: any = {
    id: 1,
    summons: JSON.stringify([
      { name: '自己的宠物', ownerQQ: '7', markers: '{}' },
      { name: '自己的第二只', ownerQQ: '42', markers: '{}' },
      { name: '公共NPC', ownerQQ: 'other', markers: '{}' },
      { name: '防御阵地', ownerQQ: '7', markers: JSON.stringify({ 阵地: 1 }) },
    ]),
  };
  const service = Object.create(GameService.prototype) as any;
  service.logger = { log: jest.fn() };
  service.playerService = {
    getPlayerData: jest.fn(async () => ({ player })),
    safeJsonParse: parseJson,
  };
  service.mapService = {
    getMapById: jest.fn(async () => map),
    updateDynamicFields: jest.fn(async (_id: number, data: any) => Object.assign(map, data)),
  };
  return { service, map };
}

describe('全部宠物模式操作', () => {
  it('全部跟随只修改归属玩家且非阵地宠物', async () => {
    const { service, map } = makeService();

    await expect(service.handleFollowAll(42)).resolves.toContain('2 只宠物');
    const summons = parseJson(map.summons, []);
    expect(summons[0]).toEqual(expect.objectContaining({ follow: true, mode: 'follow' }));
    expect(summons[1]).toEqual(expect.objectContaining({ follow: true, mode: 'follow' }));
    expect(summons[2]).not.toHaveProperty('follow');
    expect(summons[3]).not.toHaveProperty('follow');
  });

  it('全部停下/主动/被动都会持久化对应状态和原版标记', async () => {
    const { service, map } = makeService();

    await service.handleAllStop(42);
    let summons = parseJson(map.summons, []);
    expect(summons[0]).toEqual(expect.objectContaining({ follow: false, mode: 'idle' }));
    expect(parseJson(summons[0].markers, {})).toEqual(expect.objectContaining({ 跟随: 1 }));

    await service.handleAllActive(42);
    summons = parseJson(map.summons, []);
    expect(summons[0]).toEqual(expect.objectContaining({ active: true, mode: 'active' }));
    expect(parseJson(summons[0].markers, {})).toEqual(expect.objectContaining({ 主动: 0 }));

    await service.handleAllPassive(42);
    summons = parseJson(map.summons, []);
    expect(summons[0]).toEqual(expect.objectContaining({ active: false, mode: 'passive' }));
    expect(parseJson(summons[0].markers, {})).toEqual(expect.objectContaining({ 主动: 1 }));
  });
});

describe('单目标设置跟随', () => {
  function makeSetFollowService(map: any, player: any = { id: 7, userId: 42, mapId: 3, name: '玩家' }) {
    const service = Object.create(FamiliarSystemService.prototype) as any;
    service.playerService = {
      getPlayerData: jest.fn(async () => ({ player })),
      safeJsonParse: parseJson,
    };
    service.mapService = {
      getMapById: jest.fn(async () => map),
      updateDynamicFields: jest.fn(async (_id: number, data: any) => Object.assign(map, data)),
    };
    service.prisma = {
      user: { findUnique: jest.fn(async () => ({ qqNumber: 'qq-42', externalId: 'ext-42' })) },
    };
    service.staticData = {
      getMonsterByName: jest.fn(() => ({ vitality: -31 })),
    };
    return service;
  }

  it('执行原版的幼崽/阵地门禁和高好感转归属', async () => {
    const blockedMap: any = {
      id: 3,
      summons: JSON.stringify([{ name: '幼崽', ownerQQ: '7', markers: JSON.stringify({ 幼崽: 1 }) }]),
    };
    const blocked = makeSetFollowService(blockedMap);
    await expect(blocked.setFollow(42, '幼崽', true)).resolves.toContain('还不能行走');
    expect(blocked.mapService.updateDynamicFields).not.toHaveBeenCalled();

    const recruitMap: any = {
      id: 3,
      summons: JSON.stringify([{
        name: '小雫',
        qq: 'npc2g',
        ownerQQ: 'npc',
        markers: JSON.stringify({ 好感42: 100 }),
      }]),
    };
    const recruit = makeSetFollowService(recruitMap);
    await expect(recruit.setFollow(42, '小雫', true)).resolves.toContain('开始跟随');
    const summons = parseJson(recruitMap.summons, []);
    expect(summons[0]).toEqual(expect.objectContaining({ ownerQQ: 'qq-42', follow: true, mode: 'follow' }));
    expect(summons[0].qq).not.toBe('npc2g');
  });

  it('非归属目标好感不足时拒绝控制', async () => {
    const map: any = {
      id: 3,
      summons: JSON.stringify([{ name: '陌生宠物', ownerQQ: 'npc', markers: JSON.stringify({ 好感42: 99 }) }]),
    };
    const service = makeSetFollowService(map);
    await expect(service.setFollow(42, '陌生宠物', true)).resolves.toContain('好感不足100');
    expect(service.mapService.updateDynamicFields).not.toHaveBeenCalled();
  });

  it('省略第二参数时按原版跟随标记切换，并在操作时结算幼崽成长', async () => {
    const map: any = {
      id: 3,
      mapIndex: 3,
      summons: JSON.stringify([{
        name: '幼崽宠物',
        type: '普拉娜',
        ownerQQ: '7',
        follow: false,
        markers: JSON.stringify({ 幼崽: 30, 时间2: Math.floor(Date.now() / 1000) - 60, 跟随: 1 }),
      }]),
    };
    const service = makeSetFollowService(map);

    await expect(service.setFollow(42, '幼崽宠物')).resolves.toContain('开始跟随');
    const summon = parseJson(map.summons, [])[0];
    expect(summon.follow).toBe(true);
    expect(parseJson(summon.markers, {})).toEqual(expect.objectContaining({ 跟随: 0 }));
    expect(parseJson(summon.markers, {})).not.toHaveProperty('幼崽');
    expect(summon.vitality).toBe(-31);
  });
});
