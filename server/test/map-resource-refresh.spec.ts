import { MapService } from '../src/modules/game/map.service';

function makeFixture() {
  const map: any = {
    id: 7,
    name: '测试地图',
    resources: JSON.stringify([{ name: '未耗尽资源', times: 5, gatherCmd: '采集未耗尽资源' }]),
    resources2: '[]',
    markers2: JSON.stringify([
      { name: '刷新资源已耗尽资源', expireAt: Math.floor(Date.now() / 1000) - 1 },
      { name: '其他状态', expireAt: Date.now() + 60_000 },
    ]),
  };
  const prisma: any = {
    gameMap: {
      findUnique: jest.fn(async () => map),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(map, data);
        return map;
      }),
    },
  };
  const staticData: any = {
    getMapByName: jest.fn(() => ({
      resources: JSON.stringify([
        { name: '未耗尽资源', times: 5, gatherCmd: '采集未耗尽资源' },
        { name: '已耗尽资源', times: 3, gatherCmd: '采集已耗尽资源' },
      ]),
    })),
    getAllResources: jest.fn(() => []),
  };
  const service = new MapService(
    prisma,
    staticData,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
  );
  return { service, map, prisma };
}

describe('地图资源按过期标记刷新', () => {
  it('只恢复过期资源，保留未耗尽资源并兼容秒级时间戳', async () => {
    const fixture = makeFixture();

    const restored = await fixture.service.refreshExpiredMapResources(7);
    // GameMap Json 列在 Prisma 中为原生对象/数组（非字符串），refreshExpiredMapResources 锁内闭环重读后直接写对象
    const resources = fixture.map.resources;
    const markers2 = fixture.map.markers2;

    expect(restored).toBe(1);
    expect(resources.map((resource: any) => resource.name)).toEqual([
      '未耗尽资源',
      '已耗尽资源',
    ]);
    expect(markers2).toEqual([
      expect.objectContaining({ name: '其他状态' }),
    ]);
    expect(fixture.prisma.gameMap.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: expect.objectContaining({
        markers2: expect.arrayContaining([expect.objectContaining({ name: '其他状态' })]),
      }),
    }));
  });
});
