import { MapService } from '../src/modules/game/map.service';

function makeMapService(options: {
  players?: Array<{ houseName: string }>;
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
      update: jest.fn(async (args: any) => {
        const row = maps.find((m) => m.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
      deleteMany: jest.fn(async (args: any) => {
        const names: string[] = args?.where?.name?.in ?? [];
        const removed = maps.filter((m) => names.includes(m.name));
        for (const m of removed) {
          const idx = maps.indexOf(m);
          if (idx >= 0) maps.splice(idx, 1);
        }
        return { count: removed.length };
      }),
      create: jest.fn(),
    },
    player: {
      findMany: jest.fn(async () => players.slice()),
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
  return { service, maps };
}

describe('家园数据清理与防复发（MapService）', () => {
  it('removeHouseData：删除三张图并摘掉全库入口', async () => {
    const { service, maps } = makeMapService({
      maps: [
        {
          id: 3, name: '森林出口', isFrontier: false,
          connections: [
            { name: '城镇出口', distance: 100 },
            { name: '幽灵院', distance: 10, isFrontier: true },
          ],
        },
        { id: 10, name: '幽灵院', isFrontier: true, connections: [] },
        { id: 11, name: '幽灵院屋内', isFrontier: true, connections: [] },
        { id: 12, name: '幽灵院前线', isInstance: true, connections: [] },
      ],
    });

    await service.removeHouseData('幽灵院');

    expect(maps.find((m) => m.name === '幽灵院')).toBeUndefined();
    expect(maps.find((m) => m.name === '幽灵院屋内')).toBeUndefined();
    expect(maps.find((m) => m.name === '幽灵院前线')).toBeUndefined();
    const forest = maps.find((m) => m.id === 3);
    expect(forest.connections).toEqual([{ name: '城镇出口', distance: 100 }]);
  });

  it('purgeOrphanHomeData：只保留有主家园，清掉幽灵连接', async () => {
    const { service, maps } = makeMapService({
      players: [{ houseName: '红巨星3732069' }],
      maps: [
        {
          id: 3, name: '森林出口', isFrontier: false,
          connections: [
            { name: '城镇出口', distance: 100 },
            { name: '红巨星3732069', mapId: 957, distance: 10, isFrontier: true },
            { name: '超新星571057506', mapId: 228, distance: 10, isFrontier: true },
            { name: '巅峰阁', mapId: 240, distance: 10, isFrontier: true },
          ],
        },
        { id: 228, name: '超新星571057506', isFrontier: true, connections: [] },
        { id: 240, name: '巅峰阁', isFrontier: true, connections: [] },
        { id: 241, name: '桃花源', isFrontier: true, connections: [] },
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
