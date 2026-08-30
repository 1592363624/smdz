import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';

describe('宠物搜索物品', () => {
  const parse = (value: any, fallback: any) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  };

  const sequence = (...values: number[]) => {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)] ?? 0;
  };

  function createService(options: {
    player: any;
    map?: any;
    itemText?: string;
    equipmentText?: string;
    building?: string;
  }) {
    const player = options.player;
    const playerService: any = {
      getPlayerData: jest.fn().mockResolvedValue({
        player,
        markers: parse(player.markers ?? player.标记, {}),
      }),
      getBackpackItems: jest.fn((source: any) => parse(source.backpack ?? source.背包, [])),
      safeJsonParse: parse,
      getMarkerValue: jest.fn((source: any, key: string) => Number((source || {})[key] || 0)),
      savePlayer: jest.fn().mockResolvedValue(undefined),
    };
    const mapService: any = {
      getMapById: jest.fn().mockResolvedValue(options.map ?? {
        id: 1,
        name: '医疗室',
        summons: JSON.stringify([]),
      }),
      getConnections: jest.fn().mockReturnValue([]),
    };
    const staticData: any = {
      getMerchantConfig: jest.fn().mockReturnValue({
        itemText: options.itemText ?? '木头2',
        equipmentText: options.equipmentText ?? '',
      }),
      getMerchantExtraItems: jest.fn().mockReturnValue([]),
      getBuildingByName: jest.fn((name: string) => name === options.building ? { name } : undefined),
    };
    const itemSystem: any = {
      generateMerchantEquipment: jest.fn(async (name: string) => ({
        name,
        type: '装备',
        quantity: 1,
        data: '@@行商出售',
      })),
    };
    const service = new FamiliarSkillsService(
      {} as any,
      playerService,
      {} as any,
      {} as any,
      {} as any,
      itemSystem,
      mapService,
      {} as any,
      {} as any,
      staticData,
      {} as any,
      {} as any, // mutateService
    );
    return { service, playerService, mapService, staticData, itemSystem };
  }

  function player(overrides: any = {}) {
    return {
      mapId: 1,
      markers: JSON.stringify({}),
      markers2: '[]',
      backpack: '[]',
      sets: '{}',
      ...overrides,
    };
  }

  function summon(overrides: any = {}) {
    return {
      name: '测试宠物',
      ownerQQ: '1',
      markers: JSON.stringify({ 好感1: 140 }),
      equipment: '[]',
      ...overrides,
    };
  }

  it('按原始好感减去100计算几率，并在达到200时生成行商装备', async () => {
    const p = player({
      markers: JSON.stringify({ 活力2: 100 }),
    });
    const map = {
      id: 1,
      name: '医疗室',
      summons: JSON.stringify([summon({ markers: JSON.stringify({ 好感1: 200 }) })]),
    };
    const { service, itemSystem } = createService({
      player: p,
      map,
      itemText: '木头2',
      equipmentText: '行商剑',
    });

    const result = await service.searchPetItems(1, 1_000_000, sequence(0, 0, 0, 0));

    expect(result).toContain('触发几率25%');
    expect(result).toContain('行商剑[装备]');
    expect(itemSystem.generateMerchantEquipment).toHaveBeenCalledWith('行商剑', false);
    expect(JSON.parse(p.backpack)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '木头', quantity: 2 }),
      expect.objectContaining({ name: '行商剑', type: '装备' }),
    ]));
    expect(JSON.parse(p.markers2)).toEqual([
      { name: '宠搜', expireAt: 1_000_600 },
    ]);
  });

  it('低于200好感时不会误走高好感分支', async () => {
    const p = player();
    const map = {
      id: 1,
      name: '医疗室',
      summons: JSON.stringify([summon({ markers: JSON.stringify({ 好感1: 150 }) })]),
    };
    const { service, itemSystem } = createService({ player: p, map, equipmentText: '行商剑' });

    const result = await service.searchPetItems(1, 1_000_000, sequence(0.2));

    expect(result).toBe('');
    expect(itemSystem.generateMerchantEquipment).not.toHaveBeenCalled();
    expect(p.markers2).toBe('[]');
  });

  it('历史魅力同时影响数量和宠搜冷却', async () => {
    const p = player({ markers: JSON.stringify({ 活力2: 300 }) });
    const map = {
      id: 1,
      name: '医疗室',
      summons: JSON.stringify([summon()]),
    };
    const { service } = createService({ player: p, map, itemText: '木头2' });

    const result = await service.searchPetItems(1, 1_000_000, sequence(0, 0, 0));

    expect(result).toContain('木头x6');
    expect(result).toContain('冷却300秒');
  });

  it('麒麟按原版1/5/2随机数量倍率处理', async () => {
    const p = player();
    const map = {
      id: 1,
      name: '医疗室',
      summons: JSON.stringify([summon({
        name: '麒麟',
        vitality: -13,
        markers: JSON.stringify({ 好感1: 200 }),
      })]),
    };
    const { service } = createService({ player: p, map, itemText: '木头2' });

    const result = await service.searchPetItems(1, 1_000_000, sequence(0, 0.4, 0, 0, 0));

    expect(result).toContain('木头x10');
  });

  it('白套装 bj2=1 增加20%，小挎包和建筑会追加搜索次数', async () => {
    const p = player({
      sets: JSON.stringify({ 白: true }),
      markers: JSON.stringify({ 活力2: 100, bj2: 1 }),
    });
    const map = {
      id: 1,
      name: '医疗室',
      summons: JSON.stringify([summon({
        equipment: JSON.stringify([{ name: '小挎包' }]),
      })]),
    };
    const { service } = createService({
      player: p,
      map,
      itemText: '地基1,木头1',
      building: '地基',
    });

    const result = await service.searchPetItems(1, 1_000_000, sequence(0, 0.4, 0, 0.11, 0.21, 0.99));
    const backpack = JSON.parse(p.backpack);

    expect(result).toContain('地基x1');
    expect(backpack.find((item: any) => item.name === '地基').quantity).toBe(1);
    expect(backpack.length).toBe(3);
    expect(result).toContain('物品数量+20%');
  });

  it('兼容宠物和物品的中文旧字段，并保留原字段数量', async () => {
    const p = player({
      markers: undefined,
      标记: JSON.stringify({ 活力2: 100 }),
      markers2: undefined,
      标记2: '[]',
      backpack: undefined,
      背包: JSON.stringify([{ 名称: '木头', 类型: '资源', 数量: 1 }]),
    });
    const map = {
      id: 1,
      name: '医疗室',
      summons: JSON.stringify([summon({
        name: undefined,
        名称: '测试宠物',
        ownerQQ: undefined,
        归属: '1',
        markers: undefined,
        标记: JSON.stringify({ 好感1: 140 }),
      })]),
    };
    const { service } = createService({ player: p, map, itemText: '木头1' });

    await service.searchPetItems(1, 1_000_000, sequence(0, 0, 0));

    const backpack = JSON.parse(p.背包);
    expect(backpack).toEqual([
      { 名称: '木头', 类型: '资源', 数量: 2 },
    ]);
    expect(JSON.parse(p.标记2)).toEqual([
      { name: '宠搜', expireAt: 1_000_600 },
    ]);
  });
});
