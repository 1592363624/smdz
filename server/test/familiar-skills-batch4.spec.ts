import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function makeSkillsService(options: {
  player?: any;
  monsters?: any[];
  otherMaps?: any[];
} = {}) {
  const player: any = options.player || {
    id: 1, userId: 42, name: '冒险者', mapId: 7, type: '龙姬',
    hp: 100, maxHp: 100, affinity: 0,
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}', buffs: '[]',
  };
  const currentMap: any = {
    id: 7, name: '当前地图', markers2: '[]', summons: '[]',
  };
  const otherMap: any = {
    id: 8, name: '远处地图', markers2: '[]', summons: '[]',
  };
  const service: any = Object.create(FamiliarSkillsService.prototype);
  Object.assign(service, {
    prisma: {
      player: {
        findMany: jest.fn(async () => []),
      },
    },
    playerService: {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: parseJson(player.markers, {}),
        markers2: parseJson(player.markers2, []),
        equipment: parseJson(player.equipment, []),
      })),
      getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
      setMarker: jest.fn((markers: any, name: string, value: any) => {
        markers[name] = value;
      }),
      savePlayer: jest.fn(async () => undefined),
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => any) => fn()),
      getSkillLevel: jest.fn((markers: any, name: string) => {
        const proficiency = Math.max(0, Number(markers?.[`${name}技能熟练度`] ?? 0));
        let level = 1;
        while (proficiency >= level * level) level += 1;
        return level;
      }),
      isPlayerDead: jest.fn((p: any) => Number(p?.hp ?? 1) <= 0),
      handlePlayerDeath: jest.fn(() => '你死了'),
      getBackpackItems: jest.fn((p: any) => parseJson(p.backpack, [])),
      safeJsonParse: parseJson,
    },
    mapService: {
      getMapById: jest.fn(async (id: number) => Number(id) === 8 ? otherMap : currentMap),
      getAllMaps: jest.fn(async () => [currentMap, otherMap]),
      getMapMonsters: jest.fn(async () => options.monsters ?? []),
      mutateMapFields: jest.fn(async (_mapId: number, _fields: string[], fn: (f: any) => any) => {
        const f: any = { markers2: parseJson(currentMap.markers2, []) };
        fn(f);
        currentMap.markers2 = JSON.stringify(f.markers2);
        return true;
      }),
      mutateSummons: jest.fn(async (mapId: number, fn: (s: any[]) => any) => {
        const target = Number(mapId) === 8 ? otherMap : currentMap;
        const summons = parseJson(target.summons, []);
        fn(summons);
        target.summons = JSON.stringify(summons);
        return summons;
      }),
      removeMapMonster: jest.fn(async () => undefined),
    },
    combatSystem: {
      weaponAttack: jest.fn(async () => ({ result: '攻击结算文本' })),
      triggerMapBattleLoop: jest.fn(async () => undefined),
      buildAttackerBonus: jest.fn(() => ({ 生命: 100, 物伤: 50, 冰伤: 0, 火伤: 0, 电伤: 0 })),
    },
    taskService: { advance: jest.fn(async () => '') },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    systemConfig: {
      get: jest.fn(async (_key: string, defaultValue: any) => defaultValue),
    },
    familiarSystem: { getSkillEffect: jest.fn(() => 1) },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, player, currentMap, otherMap };
}

function makePlayer(overrides: Record<string, any>) {
  return {
    id: 1, userId: 42, name: '冒险者', mapId: 7,
    hp: 100, maxHp: 100, affinity: 0, location: '当前地图',
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}', buffs: '[]',
    ...overrides,
  };
}

describe('使魔技能第四批：召唤/召唤银龙/冻结傀儡/封印解除/全弹发射/纳米模式（原版 L2100-2343 复刻验证）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('召唤：次元手环门禁、600秒冷却键、新建凯露（生命=等级×100、荆棘之翼）', async () => {
    const noBracelet = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await noBracelet.service.executeSkill(42, '召唤')).toContain('需要次元手环');

    const { service, player, currentMap } = makeSkillsService({
      player: makePlayer({
        type: '史莱姆', level: 6,
        equipment: JSON.stringify([{ name: '次元手环' }]),
      }),
    });
    const result = await service.executeSkill(42, '召唤');

    expect(result).toContain('召唤出了一只凯露');
    const summons = parseJson(currentMap.summons, []);
    const caelu = summons.find((s: any) => s.name === '凯露');
    expect(caelu).toBeTruthy();
    expect(Number(caelu.当前生命)).toBe(600); // 等级6 × 100
    expect(caelu.装备[0].name).toBe('荆棘之翼');
    expect(caelu.qq.startsWith('召唤物')).toBe(true);
    expect(caelu.qq.endsWith('x')).toBe(true);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '召唤冷却1')).toBeTruthy();
  });

  it('召唤银龙：古月娜门禁、60秒冷却键、新建银龙（QQ=召唤物+归属+x、爪子武器）', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '召唤银龙')).toContain('这是古月娜的技能');

    const { service, player, currentMap } = makeSkillsService({
      player: makePlayer({ type: '古月娜', qqNumber: '123' }),
    });
    const result = await service.executeSkill(42, '召唤银龙');

    expect(result).toContain('召唤出了一条银龙');
    const summons = parseJson(currentMap.summons, []);
    const dragon = summons.find((s: any) => s.type === '银龙');
    expect(dragon).toBeTruthy();
    expect(dragon.qq).toBe('召唤物123x');
    expect(Number(dragon.当前生命)).toBe(1);
    expect(dragon.武器[0].name).toBe('爪子');
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '召唤冷却2')).toBeTruthy();
  });

  it('召唤银龙：已有银龙时传送来到当前地图而非重复创建', async () => {
    const { service, currentMap, otherMap } = makeSkillsService({
      player: makePlayer({ type: '古月娜', qqNumber: '123' }),
      otherMaps: [],
    });
    otherMap.summons = JSON.stringify([{ type: '银龙', qq: '召唤物123x', 当前生命: 5 }]);

    const result = await service.executeSkill(42, '召唤银龙');

    expect(result).toContain('之前召唤的银龙传送来到了');
    const here = parseJson(currentMap.summons, []);
    expect(here.find((s: any) => s.type === '银龙')).toBeTruthy();
    const there = parseJson(otherMap.summons, []);
    expect(there.find((s: any) => s.type === '银龙')).toBeUndefined();
  });

  it('冻结傀儡：四糸乃门禁、无怪练习文本、有怪倍率=a1×(150+5×等级)/存活数', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '冻结傀儡')).toContain('这是四糸乃的技能');

    const practice = makeSkillsService({
      player: makePlayer({ type: '四糸乃' }),
      monsters: [],
    });
    expect(await practice.service.executeSkill(42, '冻结傀儡')).toContain('对着空气练习了冻结傀儡');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '四糸乃',
        markers: JSON.stringify({ 四糸乃好感: 100, 四糸乃a: 0 }),
      }),
      monsters: [{ hp: 10 }, { hp: 10 }],
    });
    await service.executeSkill(42, '冻结傀儡');

    // 好感≥100：四糸乃a=3、a1=1.5；倍率 = (1.5/2)×(150+5×1) = 116（向下取整）
    expect(parseJson(player.markers, {})['四糸乃a']).toBe(3);
    expect(service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      damageMultiplier: 116, attackText: '空间震b', allAttack: true,
    }));
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '四糸乃技能冷却')).toBeTruthy();
  });

  it('封印解除：小樱门禁、封印解除增益时长=库洛牌×(技能等级+20)、启木之本樱回满三池', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '封印解除')).toContain('这是小樱的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '小樱',
        markers: JSON.stringify({ 小樱技能熟练度: 9 }), // 技能等级 4（9>=4, 9<9 不成立→4）
        equipment: JSON.stringify([{ name: '库洛牌' }]),
      }),
    });
    await service.executeSkill(42, '封印解除');
    const buffs = parseJson(player.buffs, []);
    const seal = buffs.find((b: any) => b.name === '封印解除');
    expect(seal).toBeTruthy();
    // 时长 = 1.25 × (等级 + 20)（等级由熟练度推导，≥1）
    expect(seal.expireAt - Date.now() / 1000).toBeGreaterThan(20);

    // 启木之本樱：三池无条件回满
    const kiyoi = makeSkillsService({
      player: makePlayer({ type: '启木之本樱', hp: 10, maxHp: 100, armor: 0, maxArmor: 30, shield: 0, maxShield: 20 }),
    });
    await kiyoi.service.executeSkill(42, '封印解除');
    expect(Number(kiyoi.player.hp)).toBe(100);
    expect(Number(kiyoi.player.armor)).toBe(30);
    expect(Number(kiyoi.player.shield)).toBe(20);
  });

  it('全弹发射：长萌门禁文本、冷却键长萌技能冷却、长萌技能增益 20×a3、全弹发射a文本', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '全弹发射')).toContain('这是长萌的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '长萌',
        equipment: JSON.stringify([{ name: '库洛牌' }]),
      }),
      monsters: [{ hp: 10 }],
    });
    await service.executeSkill(42, '全弹发射');

    expect(service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      damageMultiplier: 105, attackText: '全弹发射a', allAttack: true,
    }));
    const buffs = parseJson(player.buffs, []);
    const buff = buffs.find((b: any) => b.name === '长萌技能');
    expect(buff).toBeTruthy();
    expect(buff.expireAt - Date.now() / 1000).toBeLessThanOrEqual(25); // 20×1.25
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '长萌技能冷却')).toBeTruthy();
  });

  it('纳米模式：6件纳米装备门禁、共享“生化装”90秒冷却、增益名=模式名20秒', async () => {
    const noSet = makeSkillsService({
      player: makePlayer({ type: '史莱姆', equipment: JSON.stringify([{ name: '纳米头盔' }]) }),
    });
    const noSetResult = await noSet.service.executeSkill(42, '力量模式');
    expect(noSetResult).toContain('需要身上装备纳米头盔、臂甲、手套、装甲、裤子、鞋');

    const sixSet = makeSkillsService({
      player: makePlayer({
        type: '史莱姆',
        equipment: JSON.stringify([
          { name: '纳米头盔' }, { name: '纳米臂甲' }, { name: '纳米手套' },
          { name: '纳米装甲' }, { name: '纳米裤子' }, { name: '纳米鞋' },
        ]),
      }),
    });
    const result = await sixSet.service.executeSkill(42, '力量模式');
    expect(result).toContain('Maximun strong');
    const buffs = parseJson(sixSet.player.buffs, []);
    expect(buffs.find((b: any) => b.name === '力量模式').expireAt - Date.now() / 1000).toBeLessThanOrEqual(20);
    const markers2 = parseJson(sixSet.player.markers2, []);
    expect(markers2.find((m: any) => m.name === '生化装')).toBeTruthy();

    // 隐匿模式增益名（引擎怪物回合豁免消费点）
    const stealth = makeSkillsService({
      player: makePlayer({
        type: '史莱姆',
        equipment: JSON.stringify([
          { name: '纳米头盔' }, { name: '纳米臂甲' }, { name: '纳米手套' },
          { name: '纳米装甲' }, { name: '纳米裤子' }, { name: '纳米鞋' },
        ]),
      }),
    });
    const stealthResult = await stealth.service.executeSkill(42, '隐匿模式');
    expect(stealthResult).toContain('Cloak engage');
    const stealthBuffs = parseJson(stealth.player.buffs, []);
    expect(stealthBuffs.find((b: any) => b.name === '隐匿模式')).toBeTruthy();
  });
});
