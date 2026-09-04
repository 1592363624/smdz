/**
 * 制造指令多级分类菜单（Issue #7 修复）
 * 对应原版：
 *  - _主程序.ecode L3280-3308（制造 指令入口：无参 → 一级分类菜单；
 *    制造资源/装备/建筑 → 配方清单；制造载具 → 五个子分类菜单）
 *  - 数据显示.ecode L2338-2413（载具列表分类：按 产出[1] 物品类型过滤配方清单，
 *    顺序为 装备 → 建筑 → 部件 → 资源(排除法)）
 *  - 物品操作.ecode L2180-2195（部件类型转换：partType 数字 → 子分类名）
 */

/** 无参制造的一级分类菜单参数（原版 L3284-3286） */
export const CRAFT_CATEGORY_ARGS = ['资源', '装备', '建筑', '载具'] as const;

/** 载具子分类菜单顺序（原版 L3300：核心/功能/武器/防御/行走） */
export const VEHICLE_SUBCATEGORY_ARGS = [
  '载具核心部件',
  '载具功能部件',
  '载具武器部件',
  '载具防御部件',
  '载具行走机构',
] as const;

/** 制造指令可识别的全部分类参数（一级 + 载具子分类） */
export const CRAFT_MENU_ARGS: readonly string[] = [...CRAFT_CATEGORY_ARGS, ...VEHICLE_SUBCATEGORY_ARGS];

/**
 * 原版 部件类型转换（物品操作.ecode L2180-2195）：
 * 0→核心部件 1→防御部件 2→行走机构 4→功能部件，其余（含 3）→武器部件
 */
export function vehiclePartSubTypeName(partType: number): string {
  switch (partType) {
    case 0:
      return '核心部件';
    case 1:
      return '防御部件';
    case 2:
      return '行走机构';
    case 4:
      return '功能部件';
    default:
      return '武器部件';
  }
}

export type CraftCategory = '资源' | '装备' | '建筑' | '载具';

export interface CraftClassifyLookups {
  /** 对应原版 是否装备（equipments 配置命中） */
  isEquipment(name: string): boolean;
  /** 对应原版 取建筑（buildings 配置命中） */
  isBuilding(name: string): boolean;
  /** 对应原版 是否部件（vehicle-parts 配置命中），返回 partType 数字 */
  vehiclePartType(name: string): number | undefined;
}

/**
 * 按产出[0] 类型判定配方分类（原版 载具列表分类 数据显示.ecode L2352-2406）。
 * 不可制造（noCraft）或产出为空 → null（不进任何清单）。
 */
export function classifyCrafting(recipe: any, lookups: CraftClassifyLookups): CraftCategory | null {
  if (!recipe || recipe.noCraft) return null;
  const outputName = recipe?.outputs?.[0]?.name;
  if (!outputName) return null;
  if (lookups.isEquipment(outputName)) return '装备';
  if (lookups.isBuilding(outputName)) return '建筑';
  if (lookups.vehiclePartType(outputName) !== undefined) return '载具';
  return '资源';
}

/**
 * 提取某分类下可制造配方名清单（保持数据顺序），载具可带子分类过滤。
 * 对应原版 载具列表分类 的文本叠加与编号输入替换生成。
 */
export function listCraftingNamesByCategory(
  craftings: any[],
  category: CraftCategory,
  lookups: CraftClassifyLookups,
  subCategory?: string,
): string[] {
  const names: string[] = [];
  for (const c of craftings || []) {
    if (classifyCrafting(c, lookups) !== category) continue;
    if (category === '载具' && subCategory) {
      const t = lookups.vehiclePartType(c.outputs[0].name);
      if (t === undefined || vehiclePartSubTypeName(t) !== subCategory) continue;
    }
    names.push(c.name);
  }
  return names;
}

/** 编号临时输入替换串（原版 输入替换 += "#" + 编号 + "@" + 前缀 + 名称） */
export function buildNumberTempInput(names: string[], prefix = '制造'): string {
  return names.map((n, i) => `${i + 1}@${prefix}${n}`).join('#');
}

/** 无参制造的一级分类菜单正文（原版 L3284-3285） */
export function buildCategoryMenuText(playerName: string): string {
  return `${playerName}请选择分类:\n1、资源\n2、装备\n3、建筑\n4、载具`;
}

/** 无参制造一级菜单的临时输入替换（原版 L3286） */
export function buildCategoryMenuTempInput(): string {
  return '1@制造资源#2@制造装备#3@制造建筑#4@制造载具';
}

/** 载具子分类菜单正文与替换串（原版 L3299-3300） */
export function buildVehicleSubCategoryMenu(playerName: string): { text: string; tempInput: string } {
  return {
    text: [
      `${playerName}请选择分类`,
      ...VEHICLE_SUBCATEGORY_ARGS.map((m, i) => `${i + 1}、${m}`),
    ].join('\n'),
    tempInput: VEHICLE_SUBCATEGORY_ARGS.map((m, i) => `${i + 1}@制造${m}`).join('#'),
  };
}

/** 一级分类配方清单正文（原版 载具列表分类 的 c、配方名 叠加格式） */
export function buildCategoryListText(playerName: string, category: CraftCategory, names: string[]): string {
  return [`${playerName}请选择要制造的${category}配方:`, ...names.map((n, i) => `${i + 1}、${n}`)].join('\n');
}
