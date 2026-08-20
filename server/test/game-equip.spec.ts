import { GameService } from '../src/modules/game/game.service';

describe('装备入口序号兼容', () => {
  function makeService() {
    const player = {
      backpack: JSON.stringify([
        { name: '石斧', type: '装备' },
        { name: '皮帽', type: '装备' },
      ]),
    };
    const itemService = {
      equipItem: jest.fn(async () => '装备成功'),
    };
    const service = Object.create(GameService.prototype) as any;
    service.playerService = {
      getPlayerData: jest.fn(async () => ({ player })),
      getBackpackItems: jest.fn((value: any) => JSON.parse(value.backpack)),
    };
    service.itemService = itemService;
    return { service, itemService };
  }

  it('数字参数按背包 1-based 序号传递', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '1');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 1);
  });

  it('名称参数定位后转换为物品服务需要的 1-based 序号', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '皮帽');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 2);
  });
});
