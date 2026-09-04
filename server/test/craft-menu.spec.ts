/**
 * 制造分类菜单 回归测试（Issue #7 修复）
 * 对应原版：
 *  - _主程序.ecode L3280-3308（制造 指令入口：无参分类菜单 / 分类清单 / 载具子分类）
 *  - 数据显示.ecode L2338-2413（载具列表分类：按产出类型过滤）
 *  - 物品操作.ecode L2180-2195（部件类型转换）
 *
 * 本测试直接验证纯函数 craft-menu.util，不触碰数据库。
 */
import {
  CRAFT_MENU_ARGS,
  classifyCrafting,
  vehiclePartSubTypeName,
  listCraftingNamesByCategory,
  buildNumberTempInput,
  buildCategoryMenuText,
  buildCategoryMenuTempInput,
  buildVehicleSubCategoryMenu,
  buildCategoryListText,
  CraftClassifyLookups,
} from '../src/modules/game/craft-menu.util';

/** 模拟判定源 */
const makeLookups = (): CraftClassifyLookups => ({
  isEquipment: (n) => n.startsWith('装备'),
  isBuilding: (n) => n.startsWith('建筑'),
  vehiclePartType: (n) => {
    const table: Record<string, number> = { '部件A': 0, '部件B': 1, '部件C': 2, '部件D': 3, '部件E': 4 };
    return n in table ? table[n] : undefined;
  },
});

describe('vehiclePartSubTypeName（原版 部件类型转换）', () => {
  it('0→核心部件 1→防御部件 2→行走机构 4→功能部件 3/其他→武器部件', () => {
    expect(vehiclePartSubTypeName(0)).toBe('核心部件');
    expect(vehiclePartSubTypeName(1)).toBe('防御部件');
    expect(vehiclePartSubTypeName(2)).toBe('行走机构');
    expect(vehiclePartSubTypeName(3)).toBe('武器部件');
    expect(vehiclePartSubTypeName(4)).toBe('功能部件');
    expect(vehiclePartSubTypeName(99)).toBe('武器部件');
  });
});

describe('classifyCrafting（原版 载具列表分类 的产出类型判定）', () => {
  it('按 装备→建筑→部件→资源 顺序判定', () => {
    const lookups = makeLookups();
    expect(classifyCrafting({ noCraft: false, outputs: [{ name: '装备剑' }] }, lookups)).toBe('装备');
    expect(classifyCrafting({ noCraft: false, outputs: [{ name: '建筑机床' }] }, lookups)).toBe('建筑');
    expect(classifyCrafting({ noCraft: false, outputs: [{ name: '部件A' }] }, lookups)).toBe('载具');
    expect(classifyCrafting({ noCraft: false, outputs: [{ name: '经验胶囊' }] }, lookups)).toBe('资源');
  });

  it('noCraft / 产出为空 不进任何分类', () => {
    const lookups = makeLookups();
    expect(classifyCrafting({ noCraft: true, outputs: [{ name: '装备剑' }] }, lookups)).toBeNull();
    expect(classifyCrafting({ noCraft: false, outputs: [] }, lookups)).toBeNull();
    expect(classifyCrafting(null, lookups)).toBeNull();
  });
});

describe('listCraftingNamesByCategory（原版 配方清单过滤）', () => {
  const craftings = [
    { name: 'r1', outputs: [{ name: '装备剑' }] },
    { name: 'r2', noCraft: true, outputs: [{ name: '装备刀' }] },
    { name: 'r3', outputs: [{ name: '建筑机床' }] },
    { name: 'r4', outputs: [{ name: '部件A' }] }, // 核心部件
    { name: 'r5', outputs: [{ name: '部件B' }] }, // 防御部件
    { name: 'r6', outputs: [{ name: '部件D' }] }, // 武器部件
    { name: 'r7', outputs: [{ name: '经验胶囊' }] },
    { name: 'r8', outputs: [] },
  ];

  it('资源=排除法（非装备非建筑非部件），保持数据顺序', () => {
    expect(listCraftingNamesByCategory(craftings, '资源', makeLookups())).toEqual(['r7']);
  });

  it('装备/建筑清单', () => {
    expect(listCraftingNamesByCategory(craftings, '装备', makeLookups())).toEqual(['r1']);
    expect(listCraftingNamesByCategory(craftings, '建筑', makeLookups())).toEqual(['r3']);
  });

  it('载具全量与子分类过滤（核心部件=partType 0，武器部件=partType 3）', () => {
    expect(listCraftingNamesByCategory(craftings, '载具', makeLookups())).toEqual(['r4', 'r5', 'r6']);
    expect(listCraftingNamesByCategory(craftings, '载具', makeLookups(), '核心部件')).toEqual(['r4']);
    expect(listCraftingNamesByCategory(craftings, '载具', makeLookups(), '武器部件')).toEqual(['r6']);
    expect(listCraftingNamesByCategory(craftings, '载具', makeLookups(), '行走机构')).toEqual([]);
  });
});

describe('菜单文本与临时输入替换串', () => {
  it('无参一级分类菜单（原版 L3284-3286）', () => {
    expect(buildCategoryMenuText('测试者')).toBe('测试者请选择分类:\n1、资源\n2、装备\n3、建筑\n4、载具');
    expect(buildCategoryMenuTempInput()).toBe('1@制造资源#2@制造装备#3@制造建筑#4@制造载具');
  });

  it('载具子分类菜单顺序（原版 L3300：核心/功能/武器/防御/行走）', () => {
    const menu = buildVehicleSubCategoryMenu('测试者');
    expect(menu.text).toBe(
      '测试者请选择分类\n1、载具核心部件\n2、载具功能部件\n3、载具武器部件\n4、载具防御部件\n5、载具行走机构',
    );
    expect(menu.tempInput).toBe(
      '1@制造载具核心部件#2@制造载具功能部件#3@制造载具武器部件#4@制造载具防御部件#5@制造载具行走机构',
    );
  });

  it('分类配方清单正文与编号替换串', () => {
    expect(buildCategoryListText('测试者', '资源', ['a', 'b'])).toBe('测试者请选择要制造的资源配方:\n1、a\n2、b');
    expect(buildNumberTempInput(['a', 'b'])).toBe('1@制造a#2@制造b');
  });

  it('CRAFT_MENU_ARGS 覆盖一级分类与五个载具子分类', () => {
    expect(CRAFT_MENU_ARGS).toContain('资源');
    expect(CRAFT_MENU_ARGS).toContain('载具');
    expect(CRAFT_MENU_ARGS).toHaveLength(9);
  });
});
