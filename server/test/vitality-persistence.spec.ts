/** 活力存档兼容与怪物一次性认领回归测试。 */
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';

describe('活力存档兼容', () => {
  function makeService(row: any | null) {
    const state = { row };
    const prisma: any = {
      player: {
        findUnique: jest.fn(async () => state.row ? { ...state.row } : null),
        create: jest.fn(async ({ data }: any) => {
          state.row = { id: 1, userId: data.userId, version: 0, ...data };
          return { ...state.row };
        }),
        update: jest.fn(async ({ data }: any) => {
          state.row = { ...state.row, ...data };
          return { ...state.row };
        }),
      },
    };
    const staticData: any = {
      getTaskByName: jest.fn(() => null),
      getEquipmentByName: jest.fn(() => undefined),
    };
    const mapService: any = {
      getMapByName: jest.fn(async (name: string) => ({ id: 1, name })),
      getAllMaps: jest.fn(async () => [{ id: 1, name: '医疗室' }]),
      refreshMapMonsters: jest.fn(async () => undefined),
    };
    return { service: new PlayerService(prisma, staticData, mapService), prisma, state };
  }

  it('旧玩家首次读取缺少活力上限时补齐100，不能形成0/0', async () => {
    const { service, state } = makeService({
      id: 7,
      userId: 42,
      mapId: 1,
      location: '医疗室',
      vitality: 0,
      markers: '{}',
      markers2: '[]',
      backpack: '[]',
      equipment: '[]',
      weapons: '[]',
      buffs: '[]',
      tasks: '[]',
      safeBox: '[]',
    });

    const data = await service.getPlayerData(42);

    // 读取侧兜底：标记缺失也不显示 0/0，且不改动当期活力值
    expect(data.markers['活力2']).toBe(100);
    expect(data.player.vitality).toBe(0);
    // 补齐只落在内存快照，不主动写库（getPlayerData 是无副作用的读取，
    // 写库+刷版本会破坏 CAS 快照一致性）；随后的一次业务保存自然落库持久化。
    data.player.markers2 = JSON.stringify([{ name: '探', expireAt: 1 }]);
    await service.savePlayer(data.player);
    expect(JSON.parse(state.row.markers)['活力2']).toBe(100);
  });

  it('新玩家创建时初始化100点活力和100点历史上限', async () => {
    const { service } = makeService(null);

    const player = await service.getOrCreatePlayer(42);
    const markers = JSON.parse(player.markers);

    expect(player.vitality).toBe(100);
    expect(markers['活力2']).toBe(100);
    expect(markers['使用活力']).toBe(0);
  });
});

describe('GameMonster 一次性奖励认领', () => {
  it('deleteMany 返回0时表示怪物已被其他请求认领', async () => {
    const updateMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const service = Object.create(MapService.prototype) as MapService;
    (service as any).prisma = { gameMonster: { updateMany } };

    await expect((service as any).claimMapMonster(1, 99)).resolves.toBe(true);
    await expect((service as any).claimMapMonster(1, 99)).resolves.toBe(false);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 99, mapId: 1, rewardClaimed: false },
      data: { rewardClaimed: true },
    });
  });
});
