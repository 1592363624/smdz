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

function makeService(player: any, map: any = null): any {
  const service = Object.create(FamiliarSystemService.prototype) as any;
  service.playerService = {
    safeJsonParse: parseJson,
    getMarkerValue: (markers: any, name: string) => Number(parseJson(markers, {})?.[name] || 0),
    getPlayerData: jest.fn(async () => ({
      player,
      markers: parseJson(player.markers, {}),
    })),
    enqueueUserWrite: jest.fn(async (_uid: number, fn: () => Promise<any>) => fn()),
    savePlayer: jest.fn(async () => undefined),
  };
  service.mapService = {
    getMapById: jest.fn(async () => map),
    updateDynamicFields: jest.fn(async (_id: number, data: any) => {
      if (map) Object.assign(map, data);
    }),
  };
  service.prisma = {
    player: {
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id === player.id) Object.assign(player, data);
      }),
    },
  };
  return service;
}

describe('安乐天使/福音书目标施法', () => {
  it('只允许已装备技能物品，并支持自己和旧格式召唤物增益', async () => {
    const player: any = {
      id: 1,
      userId: 1,
      name: '冒险者',
      mapId: 1,
      equipment: '[]',
      backpack: JSON.stringify([{ name: '安乐天使', quantity: 1 }]),
      markers2: '[]',
      buffs: '[]',
      markers: '{}',
    };
    const service = makeService(player, {
      id: 1,
      summons: JSON.stringify([{ name: '小白', buffs: JSON.stringify([{ name: '旧增益' }]) }]),
    });

    await expect(service.safetyAngel(1)).resolves.toBe('需要安乐天使');

    player.equipment = JSON.stringify([{ name: '安乐天使' }]);
    await expect(service.safetyAngel(1, '[@小白]')).resolves.toContain('给小白套上了行星护盾');
    const savedSummons = parseJson(service.mapService.updateDynamicFields.mock.calls[0][1].summons, []);
    expect(savedSummons[0].buffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '旧增益' }),
      expect.objectContaining({ name: '安乐天使' }),
    ]));
  });

  it('给其他玩家使用福音书后记录每日标记，并拒绝第二次使用', async () => {
    const player: any = {
      id: 1,
      userId: 1,
      name: '施法者',
      mapId: 1,
      equipment: JSON.stringify([{ name: '福音书' }]),
      markers2: '[]',
      buffs: '[]',
      markers: '{}',
    };
    const target: any = { id: 2, userId: 2, name: '队友', buffs: '[]' };
    const service = makeService(player, { id: 1, summons: '[]' });
    service.findSkillTargetPlayer = jest.fn(async () => target);
    // 迁移后福音书写入走 playerService.enqueueUserWrite→getPlayerData→savePlayer，
    // getPlayerData 需按 userId 解析到正确的内存玩家（施法者/目标），否则写入落到施法者身上。
    service.playerService.getPlayerData = jest.fn(async (uid: number) => {
      const p = uid === target.userId ? target : player;
      return { player: p, markers: parseJson(p.markers, {}) };
    });
    service.prisma.player.update.mockImplementation(async ({ where, data }: any) => {
      if (where.id === target.id) Object.assign(target, data);
    });

    await expect(service.gospelBook(1, '队友')).resolves.toContain('给队友使用了福音书');
    expect(parseJson(target.buffs, [])).toEqual([
      expect.objectContaining({ name: '福音书', strength: 10 }),
    ]);
    expect(parseJson(player.markers, {})).toEqual({ 福音书: 1 });
    await expect(service.gospelBook(1, '队友')).resolves.toBe('一天只能使用一次');
  });

  it('非法目标不会消耗安乐天使冷却或福音书每日次数', async () => {
    const player: any = {
      id: 1,
      userId: 1,
      name: '施法者',
      mapId: 1,
      equipment: JSON.stringify([{ name: '安乐天使' }, { name: '福音书' }]),
      markers2: '[]',
      buffs: '[]',
      markers: '{}',
    };
    const service = makeService(player, { id: 1, summons: '[]' });
    service.findSkillTargetPlayer = jest.fn(async () => null);

    await expect(service.safetyAngel(1, '不存在')).resolves.toContain('不存在');
    expect(parseJson(player.markers2, [])).toEqual([]);

    await expect(service.gospelBook(1, '不存在')).resolves.toContain('不存在');
    expect(parseJson(player.markers, {})).toEqual({});
  });
});
