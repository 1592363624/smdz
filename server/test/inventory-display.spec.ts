import { GameService } from '../src/modules/game/game.service';
import { ItemService } from '../src/modules/game/item.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

/**
 * 背包展示契约（用户约定 2026-09-09）：
 * - 「背包」显示全部物品，排序=资源/材料/消耗品在前、装备在后（组内保持背包原始顺序）。
 * - 数字入参（背包 N / 装备 N）= 展示列表序号，与「背包」输出同源
 *   （前端悬浮图鉴按行序号回查「背包 N」，编号必须与展示一致）。
 * 夹具按「装备、资源、装备、资源」交错排列：任何回退到「背包原始顺序」或
 * 旧的「仅装备列表」编号实现，都会被用例 3/4/7/8 抓住。
 */
function makeInventoryService(backpackOverride?: any[]) {
  const backpack = backpackOverride ?? [
    { name: '动力臂甲', type: '装备', quantity: 1, durability: 0, data: 'c!ai300' },
    { name: '木头', type: '资源', quantity: 3.0200000000000005 },
    { name: '动力臂甲', type: '装备', quantity: 1, durability: 0, data: 's!ai900' },
    { name: '奶', type: '物品', quantity: 12.034 },
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
    getPlayerData: jest.fn(async () => ({ player, backpack, equipment: [], weapons: [], markers: {} })),
    getBackpackItems: jest.fn(() => backpack),
    // 查看装备详情（背包 N 命中装备时）走强化唯一实现：无标记=未强化
    getMarkerValue: jest.fn(() => 0),
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
    new BonusService(),
    itemService,
    {} as any,
    staticData,
  );
  const service = createGameServiceStub() as any;
  service.playerService = playerService;
  service.itemService = itemService;
  service.itemSystemService = itemSystemService;
  service.staticData = staticData;
  return { service, backpack };
}

describe('背包展示排序（资源在前、装备在后）', () => {
  it('全部物品入列，编号=展示顺序：1木头 2奶 3动力臂甲C 4动力臂甲S，无浮点尾巴', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1);

    expect(result).toContain('🎒 背包 (4种)');
    expect(result).toContain('1. 木头 ×3.02');
    expect(result).toContain('2. 奶 ×12.03');
    expect(result).toContain('3. 动力臂甲C');
    expect(result).toContain('4. 动力臂甲S');
    expect(result).not.toContain('3.0200000000000005');
    expect(result).not.toContain('12.034');
  });

  it('空背包仍是空背包文案', async () => {
    const empty = makeInventoryService([]);

    await expect(empty.service.handleInventory(1)).resolves.toBe('🎒 你的背包空空如也');
  });

  it('「背包 3」= 展示列表第 3 位（动力臂甲C）；按背包原始顺序会错命中 S', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1, '3');

    expect(result).toContain('攻击: 300');
    expect(result).not.toContain('攻击: 900');
  });

  it('「背包 4」= 展示列表第 4 位（动力臂甲S）', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1, '4');

    expect(result).toContain('攻击: 900');
    expect(result).not.toContain('攻击: 300');
  });

  it('名称入参仍查全背包（资源详情不回归）', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1, '木头');

    expect(result).toContain('木头');
    expect(result).toContain('×3.02');
  });
});

describe('装备指令数字入参编号口径（与「背包」展示列表同源）', () => {
  function makeEquipService() {
    const { service, backpack } = makeInventoryService();
    const equipItem = jest.fn(async (_userId: number, bpIndex1: number) => `装备成功#${bpIndex1}`);
    service.itemService = { equipItem };
    return { service, equipItem, backpack };
  }

  it('「装备 4」= 展示列表第 4 位（动力臂甲S，全背包下标 2 → 1-based 3）', async () => {
    const { service, equipItem } = makeEquipService();

    const result = await service.handleEquip(1, '4');

    expect(result).toContain('装备成功#3');
    expect(equipItem).toHaveBeenCalledWith(1, 3);
  });

  it('「装备 3」= 展示列表第 3 位（动力臂甲C，全背包下标 0 → 1-based 1）；旧实现会错装 S', async () => {
    const { service, equipItem } = makeEquipService();

    const result = await service.handleEquip(1, '3');

    expect(result).toContain('装备成功#1');
    expect(equipItem).toHaveBeenCalledWith(1, 1);
  });

  it('「装备 5」超出展示列表范围（共 4 种）→ 未找到，不触发装备', async () => {
    const { service, equipItem } = makeEquipService();

    const result = await service.handleEquip(1, '5');

    expect(result).toBe('背包中没有【5】');
    expect(equipItem).not.toHaveBeenCalled();
  });
});
