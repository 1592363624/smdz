import { GameService } from '../src/modules/game/game.service';
import { ItemService } from '../src/modules/game/item.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';

/**
 * 背包展示契约（2026-09-09 对齐原版分类）：
 * - 「背包」只显示装备；资源/材料/消耗品走「资源背包」（handleResourceBag）。
 * - 数字入参（背包 N / 装备 N）= 装备列表序号，与「背包」输出同源
 *   （前端悬浮图鉴按行序号回查「背包 N」，编号必须与展示一致）。
 * 夹具把「木头」放在背包首位：全背包下标与装备列表序号刻意错位，
 * 任何回退到「全背包下标」的旧实现都会被 用例2/用例4 抓住。
 */
function makeInventoryService(backpackOverride?: any[]) {
  const backpack = backpackOverride ?? [
    { name: '木头', type: '资源', quantity: 3.0200000000000005 },
    { name: '动力臂甲', type: '装备', quantity: 1, durability: 0, data: 'c!ai300' },
    { name: '动力臂甲', type: '装备', quantity: 1, durability: 0, data: 's!ai900' },
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

describe('背包装备展示（对齐原版：背包只显示装备）', () => {
  it('列表只含装备（资源被排除到「资源背包」），品质差异可见且无浮点尾巴', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1);

    expect(result).toContain('🎒 背包 (2种)');
    expect(result).toContain('1. 动力臂甲C');
    expect(result).toContain('2. 动力臂甲S');
    expect(result).not.toContain('木头');
    expect(result).not.toContain('3.0200000000000005');
  });

  it('背包里没有装备时提示走「资源背包」；全空仍是空背包文案', async () => {
    const resourcesOnly = makeInventoryService([{ name: '石头', type: '资源', quantity: 2 }]);
    const empty = makeInventoryService([]);

    await expect(resourcesOnly.service.handleInventory(1)).resolves.toContain('资源背包');
    await expect(empty.service.handleInventory(1)).resolves.toBe('🎒 你的背包空空如也');
  });

  it('按序号查看装备：序号=装备列表编号（资源占位不影响对号）', async () => {
    const { service } = makeInventoryService();

    // 装备 2 号 = 动力臂甲S（木头在首位，若按旧的全背包下标会命中木头）
    const result = await service.handleInventory(1, '2');

    expect(result).toContain('品质: 传说');
    expect(result).toContain('攻击: 900');
  });

  it('序号 1 命中第一件装备实例（品质/属性随实例）', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1, '1');

    // analyzeEquipmentItem 回包不含显示名，按实例属性区分：300 攻击=C 件，900=S 件
    expect(result).toContain('攻击: 300');
    expect(result).not.toContain('攻击: 900');
  });

  it('名称入参仍查全背包（资源详情不回归）', async () => {
    const { service } = makeInventoryService();

    const result = await service.handleInventory(1, '木头');

    expect(result).toContain('木头');
    expect(result).toContain('×3.02');
  });
});

describe('装备指令数字入参编号口径（与「背包」装备列表同源）', () => {
  function makeEquipService() {
    const { service, backpack } = makeInventoryService();
    const equipItem = jest.fn(async (_userId: number, bpIndex1: number) => `装备成功#${bpIndex1}`);
    service.itemService = { equipItem };
    return { service, equipItem, backpack };
  }

  it('「装备 2」装备装备列表第 2 件（动力臂甲S，全背包下标 3）', async () => {
    const { service, equipItem } = makeEquipService();

    const result = await service.handleEquip(1, '2');

    expect(result).toContain('装备成功#3');
    expect(equipItem).toHaveBeenCalledWith(1, 3);
  });

  it('「装备 3」超出装备列表范围（仅 2 件装备）→ 未找到，不触发装备', async () => {
    const { service, equipItem } = makeEquipService();

    const result = await service.handleEquip(1, '3');

    expect(result).toBe('背包中没有【3】');
    expect(equipItem).not.toHaveBeenCalled();
  });
});
