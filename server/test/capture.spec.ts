import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';

function parseJson<T>(value: any, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function makeCaptureFixture(feed: { quantity?: number; count?: number } = { quantity: 2 }) {
  const player: any = {
    id: 11,
    userId: 11,
    qqNumber: 'qq-capture-11',
    name: '捕捉测试者',
    mapId: 7,
    markers: '{}',
    markers2: '[]',
    buffs: '[]',
    tasks: '[]',
    backpack: JSON.stringify([{ name: '饲料', ...feed }]),
  };
  const map: any = { id: 7, name: '测试地图', monsters: '[]', summons: '[]' };
  const monster: any = {
    id: 501,
    mapId: 7,
    name: '测试史莱姆',
    type: '史莱姆',
    qq: 'monster_501',
    specialSeq: -1,
    level: 3,
    hp: 100,
    maxHp: 100,
    shield: 20,
    maxShield: 20,
    armor: 30,
    maxArmor: 30,
    attack: 12,
    defense: 4,
    speed: 100,
    bonus: JSON.stringify({ 麻醉: 225, 当前麻醉: 225 }),
    baseBonus: JSON.stringify({ 麻醉: 225 }),
    markers: JSON.stringify({ '麻醉者qq-capture-11': 1 }),
    markers2: '[]',
    buffs: '[]',
  };
  const monsters = [monster];
  const removedMonsterIds: number[] = [];
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: parseJson(player.markers, {}),
      markers2: parseJson(player.markers2, []),
      buffs: parseJson(player.buffs, []),
      equipment: [],
      weapons: [],
      backpack: parseJson(player.backpack, []),
    })),
    safeJsonParse: jest.fn(parseJson),
    getBackpackItems: jest.fn((p: any) => parseJson(p.backpack, [])),
    savePlayer: jest.fn(async () => undefined),
  };
  const mapService: any = {
    getMapById: jest.fn(async () => map),
    getMapMonsters: jest.fn(async () => monsters),
    getAllMaps: jest.fn(async () => [map]),
    updateMonsterFields: jest.fn(async (_mapId: number, monsterId: number, data: any) => {
      const current = monsters.find((item) => item.id === monsterId);
      if (current) Object.assign(current, data);
    }),
    removeMapMonster: jest.fn(async (_mapId: number, monsterId: number) => {
      removedMonsterIds.push(monsterId);
      const index = monsters.findIndex((item) => item.id === monsterId);
      if (index >= 0) monsters.splice(index, 1);
    }),
    updateDynamicFields: jest.fn(async (_mapId: number, data: any) => Object.assign(map, data)),
  };
  const staticData: any = {
    getMonsterByName: jest.fn(() => ({
      name: '测试史莱姆',
      attack: 12,
      defense: 4,
      speed: 100,
      bonus: JSON.stringify({ 麻醉: 225 }),
    })),
  };
  const service = new FamiliarSystemService(
    {} as any,
    playerService,
    {} as any,
    staticData,
    {} as any,
    mapService,
    {} as any,
    undefined,
  );
  return { player, map, monster, monsters, removedMonsterIds, playerService, mapService, service };
}

describe('GameMonster 捕捉闭环', () => {
  afterEach(() => jest.restoreAllMocks());

  it('开始捕捉将 GameMonster 写入十分钟捕捉模式', async () => {
    const fixture = makeCaptureFixture();

    const result = await fixture.service.capturePet(11, 'start', '测试史莱姆');

    expect(result).toContain('被设置为捕捉模式');
    const buffs = JSON.parse(fixture.monster.buffs);
    expect(buffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ 名称: '捕捉模式', 是否叠加时间: false }),
    ]));
    expect(fixture.mapService.updateMonsterFields).toHaveBeenCalledWith(
      7,
      501,
      expect.objectContaining({ buffs: fixture.monster.buffs }),
    );
  });

  it('麻醉值不足或没有麻醉权限时不能捕捉，也不会删除 GameMonster', async () => {
    const noPermission = makeCaptureFixture();
    noPermission.monster.markers = '{}';
    const denied = await noPermission.service.capturePet(11, 'capture', '测试史莱姆');
    expect(denied).toContain('没有权利捕捉');
    expect(noPermission.removedMonsterIds).toHaveLength(0);

    const insufficient = makeCaptureFixture();
    insufficient.monster.bonus = JSON.stringify({ 麻醉: 225, 当前麻醉: 100 });
    const notFull = await insufficient.service.capturePet(11, 'capture', '测试史莱姆');
    expect(notFull).toContain('麻醉100/225');
    expect(insufficient.removedMonsterIds).toHaveLength(0);
  });

  it.each([
    { field: 'quantity' as const, label: 'quantity' },
    { field: 'count' as const, label: 'count' },
  ])('捕捉成功兼容饲料 $label 字段并保留小数余量', async ({ field }) => {
    const fixture = makeCaptureFixture({ [field]: 2 });

    const result = await fixture.service.capturePet(11, 'capture', '测试史莱姆');

    expect(result).toContain('驯养了一只测试史莱姆');
    expect(fixture.removedMonsterIds).toEqual([501]);
    expect(fixture.monsters).toHaveLength(0);
    const summons = JSON.parse(fixture.map.summons);
    expect(summons).toHaveLength(1);
    expect(summons[0]).toEqual(expect.objectContaining({
      name: '测试史莱姆',
      specialSeq: -2,
      ownerQQ: 'qq-capture-11',
      isPet: true,
    }));
    expect(summons[0].qq).toMatch(/g$/);
    const backpack = JSON.parse(fixture.player.backpack);
    expect(backpack).toEqual([{ name: '饲料', [field]: 0.5 }]);
    expect(fixture.playerService.savePlayer).toHaveBeenCalled();
  });

  it('特殊宠物捕捉也兼容 count 字段，并在保存时保留捕捉物与奖励', async () => {
    const fixture = makeCaptureFixture({ count: 100 });
    fixture.map.summons = JSON.stringify([{ name: '花园宝宝', type: '花园宝宝' }]);
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const result = await fixture.service.capturePet(11, 'capture', '花园宝宝');

    expect(result).toContain('紧紧跟着你');
    const backpack = JSON.parse(fixture.player.backpack);
    expect(backpack).toEqual(expect.arrayContaining([
      { name: '花园宝宝', count: 1 },
      { name: '木头', count: 1 },
    ]));
    expect(backpack.some((item: any) => item.name === '饲料')).toBe(false);
    expect(JSON.parse(fixture.map.summons)).toHaveLength(0);
  });
});

describe('捕捉模式战斗层', () => {
  it('捕捉模式免疫生命池伤害，但护盾和装甲仍然承伤', async () => {
    const player: any = {
      id: 1,
      userId: 1,
      name: '攻击者',
      mapId: 7,
      hp: 100,
      maxHp: 100,
      shield: 0,
      maxShield: 0,
      armor: 0,
      maxArmor: 0,
      currentWeapon: 0,
      weapons: '[]',
      equipment: '[]',
      backpack: '[]',
      markers: '{}',
      markers2: '[]',
      buffs: '[]',
      tasks: '[]',
    };
    const monster: any = {
      id: 601,
      mapId: 7,
      name: '捕捉目标',
      type: '怪物',
      specialSeq: -1,
      hp: 100,
      maxHp: 100,
      shield: 30,
      maxShield: 30,
      armor: 20,
      maxArmor: 20,
      markers: '{}',
      markers2: '[]',
      buffs: JSON.stringify([{ 名称: '捕捉模式', 有效期至: Date.now() + 600000 }]),
      bonus: JSON.stringify({ 麻醉: 100, 当前麻醉: 0 }),
      baseBonus: JSON.stringify({ 麻醉: 100 }),
      weapons: '[]',
    };
    const map: any = { id: 7, name: '测试地图', vehicles: '[]', summons: '[]' };
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({
        player,
        backpack: [],
        equipment: [],
        weapons: [],
        markers: {},
        markers2: [],
        buffs: [],
        tasks: [],
        safeBox: [],
      })),
      safeJsonParse: jest.fn(parseJson),
      getBackpackItems: jest.fn(() => []),
      getMarkerValue: jest.fn((markers: any, key: string) => markers?.[key] ?? 0),
      isPlayerDead: jest.fn((value: any) => (value.hp || 0) <= 0),
      savePlayer: jest.fn(async () => undefined),
      addExp: jest.fn(async () => undefined),
    };
    const mapService: any = {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => [monster]),
      updateMonsterFields: jest.fn(async (_mapId: number, _id: number, data: any) => Object.assign(monster, data)),
      removeMapMonster: jest.fn(),
    };
    const staticData: any = {
      getAllBuffs: jest.fn(() => []),
      getEquipmentByName: jest.fn(() => undefined),
      getAllAttackTexts: jest.fn(() => []),
    };
    const bonusService: any = { calculateBuffs: jest.fn(), mergeBonus: jest.fn() };
    const prisma: any = {
      systemConfig: { findUnique: jest.fn(async () => ({ value: '1' })) },
      player: { findMany: jest.fn(async () => []) },
    };
    const combat = new CombatSystemService(
      prisma,
      playerService,
      bonusService,
      mapService,
      staticData,
      { addAchievement: jest.fn() } as any,
      { distributeLoot: jest.fn(async () => '') } as any,
      new CombatStateService() as any,
      { getOnlineUserIds: jest.fn(() => new Set([1])) } as any,
    );
    const attackerBonus: any = {
      攻击: 100, 攻击2: 0, 命中: 200, 命中2: 0, 闪避: 0, 闪避2: 0,
      暴击: 0, 暴击伤害: 150, 生命: 100, 护盾: 0, 装甲: 0,
      物伤: 100, 火伤: 0, 冰伤: 0, 电伤: 0,
    };
    const defenderBonus: any = {
      生命: 100, 护盾: 30, 装甲: 20, 闪避: 0, 闪避2: 0,
      护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
      装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
      生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
      生命伤害上限: 100, 护盾伤害上限: 100, 装甲伤害上限: 100,
    };
    jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(attackerBonus);
    jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue(defenderBonus);
    jest.spyOn(combat as any, 'getWeaponData').mockReturnValue({
      name: '测试武器',
      damage: 50,
      damageType: CombatSystemService.DMG_PHYS,
      type: '射弹武器',
      cooldown: 1,
      self: { anesthesia: 100 },
      properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
    } as any);
    jest.spyOn(combat as any, 'calcDamage').mockReturnValue({
      damage: 50,
      isHit: true,
      isCrit: false,
      hitRate: 100,
      damageBreakdown: { physical: 50, fire: 0, ice: 0, elec: 0 },
      poolDamage: { shield: 30, armor: 20, hp: 10 },
      critMultiplier: 1,
      rating: '',
    });
    jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

    const result = await combat.weaponAttack(1, 0, { mustHit: true, noDelay: true });

    expect(monster.hp).toBe(100);
    expect(monster.shield).toBe(0);
    expect(monster.armor).toBe(0);
    expect(result.result).toContain('捕捉中');
    expect(JSON.parse(monster.bonus)['当前麻醉']).toBe(50);
  });
});
