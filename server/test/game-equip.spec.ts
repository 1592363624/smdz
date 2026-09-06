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

describe('带品质码的装备名匹配（2026-09-06 品质错配修复）', () => {
  // 复刻生产形态：item.name 仅存基础名，品质在 data 首字符。
  // 背包里同基础名多品质混放，顺序即数组顺序。
  const backpack = JSON.stringify([
    { name: '矢量', type: '装备', data: 'e...' }, // 1
    { name: '矢量', type: '装备', data: 'd...' }, // 2
    { name: '矢量', type: '装备', data: 'c...' }, // 3
    { name: '矢量', type: '装备', data: 's...' }, // 4
    { name: '动力头盔', type: '装备', data: 'c...' }, // 5
    { name: '动力头盔', type: '装备', data: 's·特效' }, // 6
    { name: '纵横', type: '装备', data: 's...' }, // 7
    { name: '纵横', type: '装备', data: 'b·绝对零度' }, // 8
  ]);

  function makeService() {
    const player = { backpack };
    const itemService = {
      equipItem: jest.fn(async () => '装备成功'),
      // 回退 2 依赖显示名整段匹配；桩按基础名返回即可覆盖「全不匹配」的路径
      formatEquipmentInventoryDisplay: jest.fn((item: any) => item.name),
    };
    const service = Object.create(GameService.prototype) as any;
    service.playerService = {
      getPlayerData: jest.fn(async () => ({ player })),
      getBackpackItems: jest.fn((value: any) => JSON.parse(value.backpack)),
    };
    service.itemService = itemService;
    return { service, itemService };
  }

  it('穿上 矢量S 必须命中 S 品质那件，而不是第一件矢量', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '矢量S');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 4);
  });

  it('品质码不分大小写', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '矢量s');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 4);
  });

  it('带上品质码与·特效后缀时仍按基础名+品质码命中', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '动力头盔S·某特效');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 6);
  });

  it('同名同品质多件时取靠前的一件', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '纵横S');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 7);
  });

  it('指定品质不存在时不降级穿错品质，直接报未找到', async () => {
    const { service, itemService } = makeService();

    const result = await service.handleEquip(42, '动力头盔A');

    expect(itemService.equipItem).not.toHaveBeenCalled();
    expect(result).toContain('动力头盔A');
  });

  it('无品质码的纯基础名维持原 lenient 行为（取第一件同名）', async () => {
    const { service, itemService } = makeService();

    await service.handleEquip(42, '矢量');

    expect(itemService.equipItem).toHaveBeenCalledWith(42, 1);
  });
});
