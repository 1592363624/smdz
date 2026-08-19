import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';

function json<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed = JSON.parse(value);
    return (parsed === null ? fallback : parsed) as T;
  } catch {
    return fallback;
  }
}

function makeCannon(options: {
  attackMode?: number;
  markers2?: any[];
  currentRespawn?: string;
  targetRespawn?: string;
} = {}) {
  const player = {
    id: 1,
    userId: 10,
    name: '炮手',
    mapId: 1,
    mapIndex: 1,
    vehicle: 'v1',
    currentWeapon: 1,
    weapons: [{ name: '舰炮', type: '远程武器', cooldown: 4, damageType: 1, properties: { phys: 100 } }],
    sets: JSON.stringify({ attackMode: options.attackMode ?? 1 }),
    markers: '{}',
    markers2: JSON.stringify(options.markers2 || []),
    buffs: '[]',
    hp: 100,
    maxHp: 100,
    shield: 0,
    armor: 0,
  };
  const currentMap = {
    id: 1,
    mapIndex: 1,
    name: '起点',
    respawnPoint: options.currentRespawn ?? '复活点A',
    vehicles: JSON.stringify([{ id: 'v1', name: '战车', currentHp: 100, parts: [{ name: '和平鸽' }] }]),
    markers2: '[]',
  };
  const targetMap = {
    id: 2,
    mapIndex: 2,
    name: '目标谷',
    respawnPoint: options.targetRespawn ?? '复活点A',
    vehicles: '[]',
    markers2: '[]',
  };
  const monster = { id: 99, name: '飞龙', hp: 100, maxHp: 100 };
  const saved: any[] = [];
  const dynamicUpdates: any[] = [];
  const maps = new Map([[1, currentMap], [2, targetMap]]);

  const playerService: any = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: json(player.markers, {}),
      markers2: json(player.markers2, []),
      equipment: [],
      weapons: player.weapons,
      buffs: [],
      backpack: [],
      tasks: [],
    })),
    safeJsonParse: jest.fn(json),
    isPlayerDead: jest.fn(() => false),
    savePlayer: jest.fn(async (value: any) => saved.push(value)),
    getMarkerValue: jest.fn((markers: any, key: string) => markers?.[key] ?? 0),
  };
  const mapService: any = {
    getMapById: jest.fn(async (id: number) => maps.get(id) || null),
    getMapByName: jest.fn(async (name: string) => [...maps.values()].find((map) => map.name === name) || null),
    getMapMonsters: jest.fn(async (map: any) => map.id === 2 ? [monster] : []),
    updateDynamicFields: jest.fn(async (_id: number, data: any) => dynamicUpdates.push(data)),
  };
  const achievementService: any = { addAchievement: jest.fn(async () => undefined) };
  const prisma: any = { systemConfig: { findUnique: jest.fn(async () => ({ value: '1' })) } };
  const service = new CombatSystemService(
    prisma,
    playerService,
    {} as any,
    mapService,
    {} as any,
    achievementService,
    { distributeLoot: jest.fn(async () => '') } as any,
    new CombatStateService(),
    { getOnlineUserIds: jest.fn(() => new Set([10])) } as any,
  );

  return { service, player, currentMap, targetMap, monster, saved, dynamicUpdates, mapService };
}

describe('炮击复刻（_主程序.ecode L800-L950）', () => {
  it('把目标地图传入完整 weaponAttack，而不是使用简化的当前地图伤害公式', async () => {
    const fixture = makeCannon();
    const attack = jest.spyOn(fixture.service, 'weaponAttack').mockResolvedValue({
      result: '远程炮击 飞龙，造成 12 点伤害',
      killed: [],
      damageDealt: 12,
      expGained: 0,
      drops: [],
    });

    const result = await fixture.service.cannonAttack(10, '目标谷');

    expect(result).toContain('远程炮击');
    expect(attack).toHaveBeenCalledWith(10, 1, expect.objectContaining({
      targetMapId: 2,
      noDelay: true,
      allAttack: false,
      attackText: '远程炮击',
    }));
    expect(fixture.dynamicUpdates).toHaveLength(1);
  });

  it('保留原版 L826-L830 的覆盖分支：未切换炮击模式时即使有炮台也拒绝', async () => {
    const fixture = makeCannon({ attackMode: 0 });
    const attack = jest.spyOn(fixture.service, 'weaponAttack');

    const result = await fixture.service.cannonAttack(10, '目标谷');

    expect(result).toContain('需要切换为炮击模式');
    expect(attack).not.toHaveBeenCalled();
  });

  it('复刻目标地图复活点限制', async () => {
    const fixture = makeCannon({ targetRespawn: '复活点B' });
    const attack = jest.spyOn(fixture.service, 'weaponAttack');

    const result = await fixture.service.cannonAttack(10, '目标谷');

    expect(result).toContain('无法炮击处于复活点B附近的目标');
    expect(attack).not.toHaveBeenCalled();
  });

  it('复刻炮击独立冷却，冷却中不进入武器攻击', async () => {
    const fixture = makeCannon({ markers2: [{ name: '舰炮冷却', expireAt: Date.now() + 30000 }] });
    const attack = jest.spyOn(fixture.service, 'weaponAttack');

    const result = await fixture.service.cannonAttack(10, '目标谷');

    expect(result).toContain('舰炮攻击冷却中');
    expect(attack).not.toHaveBeenCalled();
  });
});
