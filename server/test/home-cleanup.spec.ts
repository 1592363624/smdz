import { MapService } from '../src/modules/game/map.service';

function makeMapService(options: {
  players?: Array<{ houseName: string; id?: number; mapId?: number; userId?: number }>;
  maps?: Array<any>;
} = {}) {
  const maps = options.maps ?? [];
  const players = options.players ?? [];
  const prisma: any = {
    gameMap: {
      findMany: jest.fn(async (args?: any) => {
        const rows = maps.slice();
        if (args?.where?.name?.in) {
          return rows.filter((m) => args.where.name.in.includes(m.name));
        }
        if (args?.where?.id?.in) {
          return rows.filter((m) => args.where.id.in.includes(m.id));
        }
        return rows.map((m) => ({ ...m }));
      }),
      findUnique: jest.fn(async (args: any) => {
        const row = maps.find((m) => m.id === args.where.id || m.name === args.where.name);
        return row ? { ...row } : null;
      }),
      findFirst: jest.fn(async (args?: any) => {
        const rows = maps.slice();
        if (args?.orderBy?.mapIndex === 'asc') {
          rows.sort((a, b) => (a.mapIndex ?? 0) - (b.mapIndex ?? 0));
        }
        return rows[0] ? { ...rows[0] } : null;
      }),
      update: jest.fn(async (args: any) => {
        const row = maps.find((m) => m.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
      deleteMany: jest.fn(async (args: any) => {
        const names: string[] = args?.where?.name?.in ?? [];
        const ids: number[] = args?.where?.id?.in ?? [];
        const removed = maps.filter((m) => names.includes(m.name) || ids.includes(m.id));
        for (const m of removed) {
          const idx = maps.indexOf(m);
          if (idx >= 0) maps.splice(idx, 1);
        }
        return { count: removed.length };
      }),
      create: jest.fn(),
    },
    player: {
      findMany: jest.fn(async (args?: any) => {
        let rows = players.slice();
        if (args?.where?.mapId?.in) {
          rows = rows.filter((p) => args.where.mapId.in.includes(p.mapId));
        }
        return rows;
      }),
      update: jest.fn(async (args: any) => {
        const row = players.find((p) => p.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
    },
    gameVehicle: {
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const service: any = Object.create(MapService.prototype);
  service.prisma = prisma;
  service.logger = { log: jest.fn(), warn: jest.fn() };
  service.safeParseJSON = (value: any, fallback: any) => {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  service.withMapLock = async (_id: number, fn: () => Promise<any>) => fn();
  service.getMapById = jest.fn(async (id: number) => maps.find((m) => m.id === id) || null);
  service.mutateMapFields = jest.fn(async (mapId: number, fields: string[], mutator: (f: any) => any) => {
    const target = maps.find((m) => m.id === mapId);
    if (!target) throw new Error(`地图不存在: ${mapId}`);
    const f: any = {};
    for (const field of fields) {
      const raw = target[field];
      f[field] = Array.isArray(raw)
        ? raw.slice()
        : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []);
    }
    const result = await mutator(f);
    for (const field of fields) target[field] = f[field];
    return result;
  });
  return { service, maps, prisma };
}

describe('家园数据清理与防复发（MapService）', () => {
  it('removeHouseData：删除三张图并摘掉全库入口', async () => {
    const { service, maps } = makeMapService({
      maps: [
        { id: 1, name: '城镇广场', mapIndex: 0, isFrontier: false, connections: [], vehicles: [] },
        {
          id: 3, name: '森林出口', isFrontier: false,
          connections: [
            { name: '城镇出口', distance: 100 },
            { name: '幽灵院', distance: 10, isFrontier: true },
          ],
        },
        { id: 10, name: '幽灵院', isFrontier: true, connections: [], vehicles: [] },
        { id: 11, name: '幽灵院屋内', isFrontier: true, connections: [], vehicles: [] },
        { id: 12, name: '幽灵院前线', isInstance: true, connections: [], vehicles: [] },
      ],
    });

    await service.removeHouseData('幽灵院');

    expect(maps.find((m) => m.name === '幽灵院')).toBeUndefined();
    expect(maps.find((m) => m.name === '幽灵院屋内')).toBeUndefined();
    expect(maps.find((m) => m.name === '幽灵院前线')).toBeUndefined();
    const forest = maps.find((m) => m.id === 3);
    expect(forest.connections).toEqual([{ name: '城镇出口', distance: 100 }]);
  });

  it('removeHouseData：家园图上的玩家/载具先迁到城镇广场再删图', async () => {
    const players = [
      {
        id: 1, userId: 100, name: '在家玩家', houseName: '幽灵院',
        mapId: 10, location: '幽灵院',
        markers: { 移动中: 1 }, markers2: [{ 名称: '移动', 数值: 1 }],
      },
    ];
    const { service, maps, prisma } = makeMapService({
      players,
      maps: [
        {
          id: 1, name: '城镇广场', mapIndex: 0, isFrontier: false,
          connections: [], vehicles: [],
        },
        {
          id: 10, name: '幽灵院', isFrontier: true, connections: [],
          vehicles: [{ vehicleId: 'VHOME', name: '停在家的车', owner: '无主' }],
        },
        { id: 11, name: '幽灵院屋内', isFrontier: true, connections: [], vehicles: [] },
      ],
    });

    await service.removeHouseData('幽灵院');

    expect(maps.find((m) => m.name === '幽灵院')).toBeUndefined();
    expect(players[0].mapId).toBe(1);
    expect(players[0].location).toBe('城镇广场');
    expect(players[0].markers).toEqual({});
    const plaza = maps.find((m) => m.id === 1);
    expect(plaza.vehicles).toEqual(expect.arrayContaining([
      expect.objectContaining({ vehicleId: 'VHOME' }),
    ]));
    expect(prisma.gameVehicle.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { mapIndex: { in: [10, 11] } },
      data: { mapIndex: 1 },
    }));
  });

  it('purgeOrphanHomeData：只保留有主家园，清掉幽灵连接', async () => {
    const { service, maps } = makeMapService({
      players: [{ id: 1, userId: 1, houseName: '红巨星3732069' }],
      maps: [
        { id: 1, name: '城镇广场', mapIndex: 0, isFrontier: false, connections: [], vehicles: [] },
        {
          id: 3, name: '森林出口', isFrontier: false,
          connections: [
            { name: '城镇出口', distance: 100 },
            { name: '红巨星3732069', mapId: 957, distance: 10, isFrontier: true },
            { name: '超新星571057506', mapId: 228, distance: 10, isFrontier: true },
            { name: '巅峰阁', mapId: 240, distance: 10, isFrontier: true },
          ],
        },
        { id: 228, name: '超新星571057506', isFrontier: true, connections: [], vehicles: [] },
        { id: 240, name: '巅峰阁', isFrontier: true, connections: [], vehicles: [] },
        { id: 241, name: '桃花源', isFrontier: true, connections: [], vehicles: [] },
        { id: 957, name: '红巨星3732069', isFrontier: true, connections: [] },
        { id: 958, name: '红巨星3732069屋内', isFrontier: true, connections: [] },
      ],
    });

    const result = await service.purgeOrphanHomeData();

    expect(result.removedMaps).toBe(3); // 超新星 / 巅峰阁 / 桃花源
    expect(maps.find((m) => m.name === '红巨星3732069')).toBeTruthy();
    expect(maps.find((m) => m.name === '红巨星3732069屋内')).toBeTruthy();
    const forest = maps.find((m) => m.id === 3);
    expect(forest.connections.map((c: any) => c.name)).toEqual(['城镇出口', '红巨星3732069']);
  });

  it('relinkHouseYardToBase：院子出口改指新宿主并保留屋内/前线', async () => {
    const { service, maps } = makeMapService({
      maps: [
        { id: 3, name: '森林出口', isFrontier: false, connections: [] },
        {
          id: 957, name: '红巨星3732069', isFrontier: true,
          connections: [
            { name: '旧宿主', mapId: 9, distance: 10, isFrontier: false },
            { name: '红巨星3732069屋内', mapId: 958, distance: 10, isFrontier: true },
            { name: '红巨星3732069前线', mapId: 959, distance: 10, isFrontier: true },
          ],
        },
      ],
    });

    await service.relinkHouseYardToBase('红巨星3732069', 3);

    const yard = maps.find((m) => m.id === 957);
    expect(yard.connections).toEqual([
      { name: '森林出口', mapId: 3, distance: 10, isFrontier: false },
      { name: '红巨星3732069屋内', mapId: 958, distance: 10, isFrontier: true },
      { name: '红巨星3732069前线', mapId: 959, distance: 10, isFrontier: true },
    ]);
  });
});
