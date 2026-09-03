import { CombatSystemService, WeaponData } from '../src/modules/game/combat-system.service';
import { BonusService, BonusData } from '../src/modules/game/bonus.service';
import { MapService } from '../src/modules/game/map.service';
import { parseJson } from './parse-json.util';

type SummonMap = {
  id: number;
  name: string;
  summons: any[];
  markers3?: any[];
};

function createCombatFixture() {
  const map: SummonMap = { id: 7, name: '测试地图', summons: [] };
  const enemyMonsters: any[] = [];
  const createdSummons: any[] = [];
  const getSummons = () => {
    if (Array.isArray(map.summons)) return map.summons;
    try { return JSON.parse(map.summons as any); } catch { return []; }
  };
  const summonExists = jest.fn(async (type: number, qq: string) => {
    if (type === 1) return getSummons().some((item: any) => String(item.qq) === String(qq));
    return enemyMonsters.some((item) => String(item.qq) === String(qq));
  });
  const createMapSummonByName = jest.fn(async (_mapId: number, name: string, options: any) => {
    const summon = {
      name,
      type: name,
      image: name,
      qq: options.qq,
      ownerQQ: options.ownerQQ || '',
      level: options.level,
      hp: 100,
      shield: 0,
      armor: 0,
      markers: '{}',
      equipmentPresets: '[]',
    };
    createdSummons.push(summon);
    return summon;
  });
  const spawnMonsterByName = jest.fn(async (_mapId: number, name: string, options: any) => {
    const monster = { name, type: name, qq: options.qq, ownerQQ: options.ownerQQ || '' };
    enemyMonsters.push(monster);
    return monster;
  });
  const mapService: any = {
    summonExists,
    createMapSummonByName,
    spawnMonsterByName,
    getMapById: jest.fn(async () => map),
    updateDynamicFields: jest.fn(async (_mapId: number, fields: any) => {
      if (fields.summons !== undefined) map.summons = JSON.parse(fields.summons);
    }),
    // 生产 mutateSummons 闭环：重读最新 summons → 跑 mutator → 写回 map（模拟锁内差异落库）
    mutateSummons: jest.fn(async (_mapId: number, mutator: (f: any) => any) => {
      const raw = (map as any).summons;
      const summons = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []);
      const result = mutator(summons);
      (map as any).summons = summons;
      return result ?? false;
    }),
    withMapLock: jest.fn(async (_mapId: number, fn: () => Promise<any>) => fn()),
  };
  const playerService: any = {
    safeJsonParse: (value: any, fallback: any) => {
      if (typeof value !== 'string') return value ?? fallback;
      try { return JSON.parse(value); } catch { return fallback; }
    },
    savePlayer: jest.fn(async () => undefined),
  };
  const staticData: any = {
    getEquipmentByName: jest.fn((name: string) => ({ name, equipType: '防具' })),
    isWeapon: jest.fn(() => false),
  };
  const combat = new CombatSystemService(
    {} as any,
    playerService,
    new BonusService(),
    mapService,
    staticData,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { combat, map, enemyMonsters, createdSummons, mapService, getSummons, playerService };
}

function playerData(overrides: Partial<any> = {}) {
  const markers2: any[] = [];
  return {
    player: {
      qqNumber: 'player-1',
      userId: 'player-1',
      name: '测试玩家',
      type: '普通玩家',
      specialSeq: 1,
      level: 30,
      markers: {},
      markers2: JSON.stringify(markers2),
      ...overrides,
    },
    markers: overrides.markers ?? {},
    markers2,
    equipment: overrides.equipment ?? [],
    weapons: [],
    backpack: [],
    buffs: [],
    tasks: [],
    safeBox: [],
  } as any;
}

const plainWeapon: WeaponData = {
  name: '自动步枪',
  damage: 10,
  damageType: 1,
  specialSeq: 0,
};

describe('攻击召唤（使魔技能.ecode L210-373）', () => {
  const now = 1_700_000_000_000;

  it('兰音召唤宇航兔，并按唯一QQ与技能冷却去重', async () => {
    const fixture = createCombatFixture();
    const data = playerData({ type: '兰音', specialSeq: 23 });

    const first = await fixture.combat.attackSummons(
      fixture.map,
      data.player,
      data,
      plainWeapon,
      now,
    );
    const second = await fixture.combat.attackSummons(
      fixture.map,
      data.player,
      data,
      plainWeapon,
      now + 1,
    );

    expect(first).toContain('#换行【一只宇航兔从地下钻了出来】');
    expect(second).toEqual([]);
    expect(fixture.getSummons()).toHaveLength(1);
    expect(fixture.getSummons()[0]).toMatchObject({
      name: '宇航兔',
      qq: '怪物宇航兔player-1xg',
      ownerQQ: 'player-1',
      level: 10,
    });
    expect(data.markers2).toHaveLength(1);
    expect(data.markers2[0].name).toBe('召yht');
  });

  it('雷火剑召唤巨型宇航兔，使用独立冷却', async () => {
    const fixture = createCombatFixture();
    const data = playerData();
    const weapon = { ...plainWeapon, name: '雷火剑', specialSeq: -34 };

    const lines = await fixture.combat.attackSummons(fixture.map, data.player, data, weapon, now);

    expect(lines).toContain('#换行【一只巨型宇航兔从地下钻了出来】');
    expect(fixture.getSummons()[0]).toMatchObject({
      name: '巨型宇航兔',
      qq: '怪物2巨航兔player-1xg',
      ownerQQ: 'player-1',
    });
    expect(data.markers2[0]).toMatchObject({ name: '召2yht', expireAt: now + 60_000 });
  });

  it('装备攻击文本召唤友方对象，且宠物分身继承名称、预设和标记', async () => {
    const fixture = createCombatFixture();
    const equipment = {
      name: '分身护符',
      equipType: '防具',
      attackText: JSON.stringify({ name: '吸血姬分身;分身跃迁入场' }),
    };
    const data = playerData({
      specialSeq: -2,
      type: '宠物',
      ownerQQ: 'owner-1',
      image: '吸血姬',
      qqNumber: 'pet-1',
      qq: 'pet-1',
      markers: { 觉醒: 2, 击杀: 3, 宝宝: 4, '好感owner-1': 5 },
      equipmentPresets: JSON.stringify([{ name: '预设一' }]),
      equipment: [equipment],
    });

    const lines = await fixture.combat.attackSummons(fixture.map, data.player, data, plainWeapon, now);
    const summon = fixture.getSummons()[0];

    expect(lines).toContain('#换行【分身跃迁入场】');
    expect(summon).toMatchObject({
      name: '吸血姬分身',
      image: '吸血姬分身',
      ownerQQ: 'owner-1',
      level: 30,
      equipmentPresets: [{ name: '预设一' }],
    });
    expect(parseJson(summon.markers, {})).toMatchObject({ 觉醒: 2, 击杀: 3, 宝宝: 4 });
    expect(parseJson(summon.markers, {})['pet-1']).toBe(14.421425);
  });

  it('敌方装备召唤写入GameMonster；重力井阻止入场但仍写入冷却', async () => {
    const fixture = createCombatFixture();
    fixture.map.markers3 = [{ name: '重力井', expireAt: now + 100_000 }];
    const equipment = {
      name: '屠龙勇士',
      equipType: '防具',
      attackText: JSON.stringify({ name: '精英火焰飞龙;精英火焰飞龙从天而降;精英火焰飞龙被重力井阻挡在外' }),
    };
    const data = playerData({ specialSeq: -1, type: '怪物', level: 60, equipment: [equipment] });

    const blocked = await fixture.combat.attackSummons(fixture.map, data.player, data, plainWeapon, now);
    expect(blocked).toContain('#换行【精英火焰飞龙被重力井阻挡在外】');
    expect(fixture.enemyMonsters).toHaveLength(0);
    expect(data.markers2[0]).toMatchObject({ name: '精英火焰飞龙冷却', expireAt: now + 60_000 });

    fixture.map.markers3 = [];
    data.markers2.length = 0;
    data.player.markers2 = JSON.stringify(data.markers2);
    const spawned = await fixture.combat.attackSummons(fixture.map, data.player, data, plainWeapon, now + 60_001);
    expect(spawned).toContain('#换行【精英火焰飞龙从天而降】');
    expect(fixture.enemyMonsters).toHaveLength(1);
    expect(fixture.enemyMonsters[0]).toMatchObject({
      name: '精英火焰飞龙',
      qq: '怪物精英火焰飞龙player-1',
      ownerQQ: '',
    });
  });
});

describe('全属性调整与召唤物存在', () => {
  it('按原版全属性调整字段统一缩放', () => {
    const bonus = new BonusService();
    const attributes: BonusData = {
      护盾: 2, 装甲: 2, 生命: 2,
      护盾火抗: 2, 护盾冰抗: 2, 护盾物抗: 2, 护盾电抗: 2,
      装甲火抗: 2, 装甲冰抗: 2, 装甲物抗: 2, 装甲电抗: 2,
      生命火抗: 2, 生命冰抗: 2, 生命物抗: 2, 生命电抗: 2,
      闪避: 2, 命中: 2, 电伤: 2, 火伤: 2, 冰伤: 2, 物伤: 2,
      暴击: 2, 暴击伤害: 2, 护盾回复: 2, 装甲回复: 2, 生命回复: 2,
      护盾回复2: 2, 装甲回复2: 2, 生命回复2: 2, 贯穿: 2, 抗贯穿: 2,
      攻击护盾: 2, 攻击装甲: 2, 攻击生命: 2,
    };

    bonus.adjustAllAttributes(attributes, 0.5);

    for (const value of Object.values(attributes)) expect(value).toBe(1);
  });

  it('召唤物存在跨地图查询友方和敌方实例', async () => {
    const mapService = Object.create(MapService.prototype) as MapService;
    (mapService as any).getAllMaps = jest.fn(async () => [
      { id: 1, summons: JSON.stringify([{ qq: 'friendly-1' }]) },
      { id: 2, summons: [{ QQ: 'friendly-2' }] },
    ]);
    const findFirst = jest.fn(async ({ where }: any) => where.qq === 'enemy-1' ? { id: 9 } : null);
    (mapService as any).prisma = { gameMonster: { findFirst } };

    await expect(mapService.summonExists(1, 'friendly-2')).resolves.toBe(true);
    await expect(mapService.summonExists(1, 'missing')).resolves.toBe(false);
    await expect(mapService.summonExists(2, 'enemy-1')).resolves.toBe(true);
    await expect(mapService.summonExists(2, 'missing')).resolves.toBe(false);
  });

  it('取羽毛按时间锚点恢复、日轮加成和扣除规则结算', () => {
    const fixture = createCombatFixture();
    const now = 1_700_000_000_000;
    const nowSec = now / 1000;
    const player = { type: '绝灭天使', skillLevel: 5, affinity: 40, buffs: '[]' };

    const fullMarkers: any = {};
    expect(fixture.combat.getFeather(player, fullMarkers, now)).toBe(15);
    expect(fullMarkers.羽毛).toBe(nowSec - 150);

    const partialMarkers: any = { 羽毛: nowSec - 50 };
    expect(fixture.combat.getFeather({ ...player, affinity: 0 }, partialMarkers, now, 2)).toBe(5);
    expect(partialMarkers.羽毛).toBe(nowSec - 30);

    const solarMarkers: any = { 羽毛: nowSec - 1_000 };
    const solarPlayer = {
      ...player,
      buffs: JSON.stringify([{ name: '日轮', expireAt: now + 60_000 }]),
    };
    expect(fixture.combat.getFeather(solarPlayer, solarMarkers, now)).toBe(22.5);

    const clearMarkers: any = { 羽毛: nowSec - 100 };
    expect(fixture.combat.getFeather({ ...player, affinity: 0 }, clearMarkers, now, -0.371)).toBe(10);
    expect(clearMarkers.羽毛).toBe(nowSec);
  });

  it('进入地图时持久化地图增益，保留剩余时间并清理上一张地图来源', async () => {
    const fixture = createCombatFixture();
    const player: any = {
      id: 1,
      buffs: JSON.stringify([
        { name: '旧地图增益', source: 'mapBuff', mapId: 6, expireAt: 1_800_000_000 },
        { name: '普通增益', source: 'skill', expireAt: 1_800_000_000 },
      ]),
    };
    const expireAt = Math.floor(Date.now() / 1000) + 120;

    await fixture.combat.applyMapBuffs(player, {
      id: 7,
      name: '新地图',
      mapBuffs: [{ name: '新地图增益', value: -15, expireAt }],
    });

    const buffs = parseJson(player.buffs, []);
    expect(buffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '普通增益', source: 'skill' }),
      expect.objectContaining({ name: '新地图增益', source: 'mapBuff', mapId: 7, strength: -15 }),
    ]));
    expect(buffs.some((item: any) => item.name === '旧地图增益')).toBe(false);
    const active = buffs.find((item: any) => item.name === '新地图增益');
    expect(active.expireAt).toBeGreaterThanOrEqual(expireAt - 1);
    expect(active.expireAt).toBeLessThanOrEqual(expireAt + 1);
    expect(fixture.playerService.savePlayer).toHaveBeenCalledWith(player);
  });
});
