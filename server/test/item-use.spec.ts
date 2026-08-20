import { ItemService } from '../src/modules/game/item.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

describe('物品使用产出闭环', () => {
  it('种子箱按使用可得随机池发放种子并消耗箱子', async () => {
    const player: any = {
      id: 1,
      userId: 42,
      name: '测试玩家',
      backpack: JSON.stringify([{
        name: '种子箱',
        type: '资源',
        quantity: 10,
        count: 10,
        durability: 0,
        data: '',
      }]),
      markers: '{}',
      markers2: '[]',
      buffs: '[]',
    };
    const prisma: any = {
      player: {
        findUnique: jest.fn(async () => player),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(player, data);
          return player;
        }),
      },
    };
    const staticData: any = {
      getItemByName: jest.fn((name: string) => name === '种子箱'
        ? {
            name,
            useEffects: JSON.stringify(['椰树种子1，椰树种子1，金龙果种子1']),
            useMarkers: '[]',
          }
        : undefined),
      getEquipmentByName: jest.fn(() => undefined),
    };
    const service = new ItemService(
      prisma as PrismaService,
      staticData as StaticDataService,
      {} as any,
    );

    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const result = await service.useItem(42, '种子箱', 10);
      const backpack = JSON.parse(player.backpack);

      expect(result).toContain('椰树种子×10');
      expect(backpack.find((item: any) => item.name === '种子箱')).toBeUndefined();
      expect(backpack.find((item: any) => item.name === '椰树种子')).toEqual(expect.objectContaining({
        quantity: 10,
        count: 10,
      }));
      expect(prisma.player.update).toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
