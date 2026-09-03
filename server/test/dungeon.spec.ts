import { DungeonService } from '../src/modules/game/dungeon.service';
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
    const prisma: any = {
      player: {
        findMany: jest.fn(async () => players),
        update: jest.fn(async ({ where, data }: any) => {
          const player = players.find((item) => item.id === where.id);
          if (player) Object.assign(player, data);
          return player;
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
    return { service: new DungeonService(prisma, playerService, mapService), maps, players, updates, mapService, prisma };
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
  });
});
