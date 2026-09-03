import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';
import { parseJson } from './parse-json.util';

describe('伊芙利特灼烂歼鬼（使魔技能.ecode L1967-2006）', () => {
  function makeFixture(overrides: any = {}) {
    const now = 1_700_000_000_000;
    const player = {
      id: 1,
      name: '伊芙利特玩家',
      type: '伊芙利特',
      specialSeq: 11,
      mapId: 1,
      currentWeapon: 2,
      affinity: 100,
      hp: 10,
      maxHp: 100,
      shield: 5,
      maxShield: 50,
      armor: 8,
      maxArmor: 80,
      equipment: JSON.stringify([
        { name: '急救包' },
        { name: '冷却核心' },
        { name: '库洛牌' },
      ]),
      markers: JSON.stringify({ 伊芙利特好感: 100 }),
      markers2: '[]',
      buffs: '[]',
      sets: '{}',
      ...overrides,
    };
    const markers = JSON.parse(player.markers);
    const markers2 = JSON.parse(player.markers2);
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({
        player,
        markers,
        markers2,
        equipment: JSON.parse(player.equipment),
        weapons: [],
        buffs: [],
        backpack: [],
        tasks: [],
        safeBox: [],
      })),
      safeJsonParse: jest.fn((value: any, fallback: any) => {
        if (value === undefined || value === null) return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return fallback; }
      }),
      getMarkerValue: jest.fn((source: any, key: string) => Number(source?.[key] || 0)),
      getSkillLevel: jest.fn(() => 1),
      savePlayer: jest.fn(async () => undefined),
    };
    const combatSystem: any = {
      weaponAttack: jest.fn(async () => ({ result: '空间震a命中', killed: [], damageDealt: 10, expGained: 0, drops: [] })),
    };
    const mapService: any = {
      getMapById: jest.fn(async () => ({ id: 1, name: '战场' })),
      getMapMonsters: jest.fn(async () => [{ id: 2, hp: 100, name: '目标' }]),
    };
    const service = new FamiliarSkillsService(
      {} as any,
      playerService,
      {} as any,
      combatSystem,
      {} as any,
      {} as any,
      mapService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // mutateService
    );
    return { service, player, markers, markers2, playerService, combatSystem };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => jest.useRealTimers());

  it('非伊芙利特返回原版技能提示', async () => {
    const fixture = makeFixture({ type: '兰音', specialSeq: 23 });
    await expect(fixture.service.scorchedFinger(1)).resolves.toBe('这是伊芙利特的技能');
  });

  it('冷却核心为50秒，急救包后回满三层，库洛牌增益持续37.5秒', async () => {
    const fixture = makeFixture();
    const result = await fixture.service.scorchedFinger(1);
    const buffs = parseJson(fixture.player.buffs, []);
    const cooldown = parseJson(fixture.player.markers2, []).find((item: any) => item.name === '伊芙利特技能冷却');

    expect(result).toContain('恢复了5护盾、8装甲、10生命');
    expect(fixture.player.hp).toBe(100);
    expect(fixture.player.shield).toBe(50);
    expect(fixture.player.armor).toBe(80);
    expect(cooldown.expireAt).toBe(1_700_000_050_000);
    expect(buffs[0].name).toBe('灼烂歼鬼');
    // 玩家 buffs 在当前运行时统一使用秒级过期时间；markers2 冷却保留毫秒级。
    expect(buffs[0].expireAt).toBe(1_700_000_037.5);
    expect(fixture.markers['伊芙利特技能熟练度']).toBe(1);
    expect(fixture.markers['使用技能']).toBe(1);
    expect(fixture.markers['活跃度']).toBe(1);
  });

  it('好感达到100且地图有怪物时调用当前武器的空间震a全体攻击', async () => {
    const fixture = makeFixture();
    await fixture.service.scorchedFinger(1);
    expect(fixture.combatSystem.weaponAttack).toHaveBeenCalledWith(1, 2, expect.objectContaining({
      noDelay: true,
      allAttack: true,
      attackText: '空间震a',
    }));
    expect(fixture.combatSystem.weaponAttack.mock.calls[0][2].mustHit).toBeUndefined();
  });

  it('技能冷却期间不重复执行效果', async () => {
    const fixture = makeFixture({ markers2: JSON.stringify([{ name: '伊芙利特技能冷却', expireAt: 1_700_000_010_000 }]) });
    const result = await fixture.service.scorchedFinger(1);
    expect(result).toContain('伊芙利特玩家还需要10秒');
    expect(fixture.combatSystem.weaponAttack).not.toHaveBeenCalled();
  });
});
