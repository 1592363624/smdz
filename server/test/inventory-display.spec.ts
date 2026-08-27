import { GameService } from '../src/modules/game/game.service';
import { ItemService } from '../src/modules/game/item.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';

function makeInventoryService() {
  const backpack = [
    { name: '动力臂甲', type: '装备', quantity: 1, durability: 0, data: 'c!ai300' },
    { name: '动力臂甲', type: '装备', quantity: 1, durability: 0, data: 's!ai900' },
    { name: '木头', type: '资源', quantity: 3.0200000000000005 },
  ];
  const staticData: any = {
    getEquipmentByName: jest.fn((name: string) => ({
      name,
      equipType: '手臂',
      specialSeq: 0,
      properties: '{}',
      baseBonus: '{}',
      affixes: '[]',
      attackText: '{}',
      buffs: '[]',
    })),
    isWeapon: jest.fn(() => false),
    getEffectById: jest.fn(),
  };
  const player = { name: '测试者', backpack: JSON.stringify(backpack) };
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, backpack, equipment: [], weapons: [] })),
    getBackpackItems: jest.fn(() => backpack),
  };
  const itemService = new ItemService(
    {} as any,
    staticData,
    {} as any,
    playerService,
    {} as any,
  );
  const itemSystemService = new ItemSystemService(
    {} as any,
    playerService,
    {} as any,
    itemService,
    {} as any,
    staticData,
  );
  const service = Object.create(GameService.prototype) as any;
  service.playerService = playerService;
  service.itemService = itemService;
  service.itemSystemService = itemSystemService;
  service.staticData = staticData;
  return { service, backpack };
}

describe('背包装备展示', () => {
  it('同名装备在列表中显示品质差异，资源数量按原版规则格式化', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1);

    expect(result).toContain('1. 动力臂甲C');
    expect(result).toContain('2. 动力臂甲S');
    expect(result).toContain('3. 木头 ×3.02');
    expect(result).not.toContain('3.0200000000000005');
  });

  it('按序号查看同名装备时展示被选中实例的品质和属性', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1, '2');

    expect(result).toContain('品质: 传说');
    expect(result).toContain('攻击: 900');
  });
});
