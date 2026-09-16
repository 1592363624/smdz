import { DungeonService, DUNGEON_ENTRY_SOURCE } from '../src/modules/game/dungeon.service';
import { parseJson } from './parse-json.util';

describe('副本生命周期（后台运作.ecode L1039-1106）', () => {
  function makeFixture() {
    const firstMaps = [
      { id: 1, name: '医疗室', isInstance: true, isFrontier: false, respawnPoint: '医疗室' },
      { id: 2, name: '走廊', isInstance: true, isFrontier: false, respawnPoint: '医疗室' },
      { id: 3, name: '森林出口', isInstance: false, isFrontier: false, respawnPoint: '森林出口' },
      { id: 4, name: 'CELL研究中心', isInstance: true, isFrontier: false, respawnPoint: 'CELL研究中心', clearMarkers: '阵列 仓库' },
      { id: 5, name: '研究中心大厅', isInstance: true, isFrontier: false, respawnPoint: 'CELL研究中心' },
      { id: 6, name: '玩家家园前线', isInstance: true, isFrontier: true, respawnPoint: '玩家家园前线' },
    ];
    const maps: any[] = Array.from({ length: 23 }, (_, index) =>
      firstMaps[index] || { id: index + 1, name: `地图${index + 1}`, isInstance: false, isFrontier: false },
    );
    maps[22] = {
      id: 23,
      name: '副本出口',
      isInstance: false,
      isFrontier: false,
      summons: JSON.stringify([{ id: 'existing-summon' }]),
      vehicles: JSON.stringify([{ id: 'existing-vehicle' }]),
    };

    const players = [
      { id: 10, userId: 10, name: '副本玩家', mapId: 4, markers: JSON.stringify({ 移动中: 1, 阵列: 1, 保留: 2 }) },
    ];
    const updates: Array<{ id: number; data: any }> = [];
    const mapService: any = {
      getAllMaps: jest.fn(async () => maps),
      getMapByName: jest.fn(async (name: string) => maps.find((map) => map.name === name) || null),
      updateDynamicFields: jest.fn(async (id: number, data: any) => updates.push({ id, data })),
      // 生产 mutateMapFields 闭环：定位地图最新字段 → 跑 mutator → 写回 map（模拟锁内差异落库）
      mutateMapFields: jest.fn(async (mapId: number, fields: string[], mutator: (f: any) => any) => {
        const target = maps.find((m: any) => m.id === mapId);
        if (!target) return {};
        const f: any = {};
        for (const field of fields) {
          const raw = (target as any)[field];
          f[field] = Array.isArray(raw)
            ? raw
            : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []);
        }
        const result = mutator(f);
        for (const field of fields) (target as any)[field] = f[field];
        return result ?? {};
      }),
      removeMapConnection: jest.fn(async () => undefined),
      clearMapMonsters: jest.fn(async () => undefined),
      refreshMapMonsters: jest.fn(async () => undefined),
      refreshMapResources: jest.fn(async () => undefined),
    };
    const vehicleUpdates: Array<{ where: any; data: any }> = [];
    const prisma: any = {
      player: {
        findMany: jest.fn(async () => players),
        update: jest.fn(async ({ where, data }: any) => {
          const player = players.find((item) => item.id === where.id);
          if (player) Object.assign(player, data);
          return player;
        }),
      },
      gameVehicle: {
        updateMany: jest.fn(async (args: any) => {
          vehicleUpdates.push(args);
          return { count: 0 };
        }),
      },
    };
    const playerService: any = {
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => Promise<any>) => fn()),
      getPlayerData: jest.fn(async (uid: number) => {
        const p = players.find((pl) => pl.userId === uid) || players[0];
        return { player: p };
      }),
      savePlayer: jest.fn(async (p: any) => p),
    };
    return { service: new DungeonService(prisma, playerService, mapService), maps, players, updates, mapService, prisma, vehicleUpdates };
  }

  it('菜单按复活点合并正式副本，并排除新手/家园地图', async () => {
    const fixture = makeFixture();
    await expect(fixture.service.getInstanceGroups()).resolves.toEqual([
      expect.objectContaining({
        name: 'CELL研究中心',
        maps: expect.arrayContaining([
          expect.objectContaining({ name: 'CELL研究中心' }),
          expect.objectContaining({ name: '研究中心大厅' }),
        ]),
      }),
    ]);
  });

  it('关闭副本迁移玩家、合并召唤物和载具、清理标记并刷新地图', async () => {
    const fixture = makeFixture();
    fixture.maps[3].summons = JSON.stringify([{ id: 'dungeon-summon' }]);
    fixture.maps[3].vehicles = JSON.stringify([{ id: 'dungeon-vehicle' }]);
    const result = await fixture.service.closeDungeon('CELL研究中心');

    expect(result.message).toContain('副本玩家被传送离开了副本');
    expect(fixture.players[0].mapId).toBe(23);
    // 原版置成就熟练度(..., 0) 会删除已存在标记，不会为缺失的“仓库”新增键。
    expect(parseJson(fixture.players[0].markers, {})).toEqual({ 保留: 2 });
    expect(fixture.mapService.removeMapConnection).toHaveBeenCalledWith(4, 'CELL研究中心(副本)');
    expect(fixture.mapService.clearMapMonsters).toHaveBeenCalledWith(4);
    expect(fixture.mapService.refreshMapMonsters).toHaveBeenCalledWith(4);
    expect(fixture.mapService.refreshMapResources).toHaveBeenCalledWith(4);

    const exitSummonsField = parseJson(fixture.maps[22].summons, []);
    expect(exitSummonsField).toEqual(expect.arrayContaining([
      { id: 'existing-summon' },
      { id: 'dungeon-summon' },
    ]));
    // 关副本后 GameVehicle.mapIndex 同步到出口，避免表行残留指向副本图
    expect(fixture.prisma.gameVehicle.updateMany).toHaveBeenCalledWith({
      where: { mapIndex: { in: [4, 5] } },
      data: { mapIndex: 23 },
    });
  });
});

describe('副本入口统一生成与脏入口清理', () => {
  /** 入口相关的地图桩：connections 真实读写，便于断言入口结构 */
  function makeEntryFixture() {
    const maps: any[] = [
      { id: 1, name: '医疗室', isInstance: true, isFrontier: false, respawnPoint: '医疗室', connections: [] },
      { id: 2, name: '走廊', isInstance: true, isFrontier: false, respawnPoint: '医疗室', connections: [] },
      { id: 3, name: '浅海', isInstance: false, isFrontier: false, respawnPoint: '沙滩', connections: [] },
      { id: 4, name: 'CELL研究中心', isInstance: true, isFrontier: false, respawnPoint: 'CELL研究中心', connections: [] },
      { id: 5, name: '灭绝之地', isInstance: true, isFrontier: false, respawnPoint: '灭绝之地', connections: [] },
    ];
    const readConnections = (map: any): any[] => {
      const raw = map?.connections;
      if (Array.isArray(raw)) return raw;
      try { return JSON.parse(raw || '[]'); } catch { return []; }
    };
    const mapService: any = {
      getAllMaps: jest.fn(async () => maps),
      getMapByName: jest.fn(async (name: string) => maps.find((m: any) => m.name === name) || null),
      getMapById: jest.fn(async (id: number) => maps.find((m: any) => Number(m.id) === Number(id)) || null),
      getConnections: jest.fn((map: any) => readConnections(map)),
      appendMapConnection: jest.fn(async (mapId: number, connection: any) => {
        const map = maps.find((m: any) => Number(m.id) === Number(mapId));
        if (!map) return;
        const list = readConnections(map);
        if (list.some((c: any) => c?.name === connection.name)) return;
        list.push(connection);
        map.connections = list;
      }),
      removeMapConnection: jest.fn(async (mapId: number, name: string) => {
        const map = maps.find((m: any) => Number(m.id) === Number(mapId));
        if (!map) return;
        map.connections = readConnections(map).filter((c: any) => c?.name !== name);
      }),
    };
    const service = new DungeonService({} as any, {} as any, mapService);
    return { service, maps, mapService };
  }

  it('两条路径生成同一结构：mapId + 距离100 + isInstance + 24h 到期', async () => {
    const { service, maps } = makeEntryFixture();
    const before = Date.now();

    const ticket = await service.openDungeonEntry(3, 'CELL研究中心', DUNGEON_ENTRY_SOURCE.TICKET);
    expect(ticket.ok).toBe(true);
    expect(ticket.mapId).toBe(4);

    const spawned = await service.openDungeonEntry(3, '灭绝之地', DUNGEON_ENTRY_SOURCE.SPAWN);
    expect(spawned.ok).toBe(true);
    expect(spawned.mapId).toBe(5);

    // 有效期默认 24h（fixture 的 prisma 桩读不到配置表，回退默认值），从开启时刻起算
    for (const entry of maps[2].connections) {
      expect(entry.expireAt).toBeGreaterThan(before + 23 * 3600 * 1000);
      expect(entry.expireAt).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);
    }
    expect(maps[2].connections.map((c: any) => `${c.name}/${c.source}/${c.mapId}`)).toEqual([
      'CELL研究中心(副本)/ticket/4',
      '灭绝之地(副本)/spawn/5',
    ]);
  });

  it('副本名不存在时不生成入口（避免产生永远进不去的入口）', async () => {
    const { service, maps } = makeEntryFixture();
    const result = await service.openDungeonEntry(3, '扭曲深渊', DUNGEON_ENTRY_SOURCE.SPAWN);
    expect(result.ok).toBe(false);
    expect(maps[2].connections).toEqual([]);
  });

  it('定时生成只追加不回收：入口累积到「刷新副本」关闭或重启重置（原版 后台运作 L22/L35）', async () => {
    const { service, maps } = makeEntryFixture();
    await service.openDungeonEntry(3, '灭绝之地', DUNGEON_ENTRY_SOURCE.SPAWN);
    await service.openDungeonEntry(3, 'CELL研究中心', DUNGEON_ENTRY_SOURCE.TICKET);
    // 原版「生成副本」纯加入成员：不同名入口都保留，同名入口幂等去重（mapId 刷新）
    await service.openDungeonEntry(3, '灭绝之地', DUNGEON_ENTRY_SOURCE.SPAWN);

    expect(maps[2].connections.map((c: any) => `${c.name}/${c.source}`)).toEqual([
      'CELL研究中心(副本)/ticket',
      '灭绝之地(副本)/spawn',
    ]);
  });

  it('清扫：过期入口删除并关闭副本组，未过期入口保留', async () => {
    const { service, maps } = makeEntryFixture();
    const now = Date.now();
    maps[2].connections = [
      { name: 'CELL研究中心(副本)', mapId: 4, expireAt: now - 1000 },
      { name: '灭绝之地(副本)', mapId: 5, expireAt: now + 3600 * 1000 },
    ];
    const closeSpy = jest.spyOn(service, 'closeDungeon').mockResolvedValue({
      name: 'CELL研究中心', movedPlayers: [], message: 'CELL研究中心副本已关闭',
    });

    const result = await service.sweepDungeonEntries();
    expect(closeSpy).toHaveBeenCalledWith('CELL研究中心');
    expect(result.closedGroups).toEqual(['CELL研究中心']);
    expect(result.expired).toBe(1);
    expect(maps[2].connections.map((c: any) => c.name)).toEqual(['灭绝之地(副本)']);
  });

  it('清扫：同副本名在别处还有未过期入口时只删到期入口，不关闭副本组', async () => {
    const { service, maps } = makeEntryFixture();
    const now = Date.now();
    maps[2].connections = [{ name: 'CELL研究中心(副本)', mapId: 4, expireAt: now - 1000 }];
    maps[3].connections = [{ name: 'CELL研究中心(副本)', mapId: 4, expireAt: now + 3600 * 1000 }];
    const closeSpy = jest.spyOn(service, 'closeDungeon');

    await service.sweepDungeonEntries();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(maps[2].connections).toEqual([]);
    expect(maps[3].connections).toHaveLength(1);
  });

  it('清扫：解析不到目标地图的无效入口直接删除（历史脏数据兜底）', async () => {
    const { service, maps } = makeEntryFixture();
    maps[2].connections = [
      { name: '扭曲深渊(副本)', distance: 100 },
      { name: '灭绝之地(副本)', mapId: 5, expireAt: Date.now() + 3600 * 1000 },
    ];
    const result = await service.sweepDungeonEntries();
    expect(result.removed).toBe(1);
    expect(maps[2].connections.map((c: any) => c.name)).toEqual(['灭绝之地(副本)']);
  });
});
