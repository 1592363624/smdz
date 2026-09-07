/**
 * 物品身份规范化唯一出口（Issue #11 架构收敛）。
 *
 * 原则：同一物品名无论从哪个渠道获得（制造 / 掉落 / 采集 / 任务奖励 / GM 发放 / 商店），
 * 写入玩家背包时必须是"同一样东西"——type 等身份数据由静态定义（equipments.json /
 * items.json，继承原版物品表）唯一决定，不允许各写入路径自造默认值产生分叉。
 *
 * 规范 type 解析优先级：
 *   1. 装备定义存在 → '装备'
 *   2. 物品定义存在 → items.json 的 type（原版 使魔大战.txt [物品名] 类型=）
 *   3. 无任何定义   → '资源'（对齐原版 获得物品：类型为空默认资源）
 *
 * 堆叠语义：非装备按名称合并（原版 获得物品 按名称合并；复刻统一为所有非装备
 * 可堆叠，避免同名不同 type 的历史脏数据永久分条）。装备永不合并（词条唯一）。
 */
import { roundItemQuantity } from '../../common/utils/game-text.util';

/** 静态定义查询接口（由 StaticDataService 适配实现） */
export interface ItemTypeLookup {
  /** 是否装备定义 */
  isEquipment(name: string): boolean;
  /** 物品定义的 type（无定义返回 undefined） */
  itemTypeName(name: string): string | undefined;
}

/** 由 StaticDataService 适配出查询接口 */
export function lookupFromStaticData(staticData: any): ItemTypeLookup {
  return {
    isEquipment: (name: string) => !!staticData?.getEquipmentByName?.(name),
    itemTypeName: (name: string) => staticData?.getItemByName?.(name)?.type,
  };
}

/**
 * 解析物品的规范 type。
 * @param name 物品名
 * @param lookup 静态定义查询
 * @param provided 写入方显式给出的 type（仅作无定义时的参考，不覆盖定义）
 */
export function canonicalItemType(
  name: string,
  lookup: ItemTypeLookup,
  provided?: string,
): string {
  if (!name) return provided ?? '资源';
  if (lookup.isEquipment(name)) return '装备';
  return lookup.itemTypeName(name) ?? provided ?? '资源';
}

/** 读取条目数量（quantity 优先，兼容 count / 数量） */
function entryQuantity(item: any): number {
  const v = Number(item?.quantity ?? item?.count ?? item?.数量 ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * 把一个物品条目合并进背包（规范化入口）。
 * - type 以静态定义为准（写入方给的 type 只在无定义时兜底）；
 * - 非装备：找同名非装备条目合并数量（两位小数口径），并自愈存量条目的历史脏 type；
 * - 装备：追加，不合并（词条唯一）。
 */
export function mergeBackpackItem(
  backpack: any[],
  item: any,
  lookup: ItemTypeLookup,
): void {
  const name = String(item?.name ?? item?.名称 ?? '').trim();
  if (!name) return;

  const canonical = canonicalItemType(name, lookup, item?.type ?? item?.类型);
  if (canonical === '装备') {
    backpack.push({ ...item, name, type: '装备' });
    return;
  }

  const existing = backpack.find(
    (bp: any) =>
      String(bp?.name ?? bp?.名称 ?? '') === name &&
      String(bp?.type ?? bp?.类型 ?? '') !== '装备',
  );
  if (existing) {
    const next = roundItemQuantity(entryQuantity(existing) + entryQuantity(item));
    // 数量镜像字段全量同步：quantity/count 为现行规范，数量 为中文旧字段
    // （兼容读取，不同步会留下指向旧值的脏镜像）
    existing.quantity = next;
    existing.count = next;
    if (existing.数量 !== undefined || item?.数量 !== undefined) existing.数量 = next;
    // 自愈：存量条目若带历史脏 type（同名不同 type 分叉的根源），收敛到规范值
    if (existing.type !== canonical) {
      existing.type = canonical;
      if (existing.类型 !== undefined || item?.类型 !== undefined) existing.类型 = canonical;
    }
    return;
  }

  const qty = roundItemQuantity(entryQuantity(item));
  backpack.push({ ...item, name, type: canonical, quantity: qty, count: qty });
}

/**
 * 全量自愈一个背包数组（读档/落库前的收敛闸）：
 * - 每个非装备条目的 type 收敛到静态定义；
 * - 同名非装备重复条目合并为一条（保留首个出现位置与其余字段，数量求和）；
 * - 装备条目原样保留。
 * 返回新数组（非装备部分为原条目对象引用，装备原样）。
 */
export function canonicalizeBackpack(backpack: any[], lookup: ItemTypeLookup): any[] {
  if (!Array.isArray(backpack)) return backpack;
  const firstIndexByName = new Map<string, number>();
  const removeIdx = new Set<number>();

  backpack.forEach((item: any, idx: number) => {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type ?? item.类型 ?? '');
    if (type === '装备') return;
    const name = String(item.name ?? item.名称 ?? '').trim();
    if (!name) return;

    const canonical = canonicalItemType(name, lookup, type || undefined);
    if (item.type !== canonical) {
      item.type = canonical;
      if (item.类型 !== undefined) item.类型 = canonical;
    }

    const first = firstIndexByName.get(name);
    if (first === undefined) {
      firstIndexByName.set(name, idx);
    } else {
      const base = backpack[first];
      const next = roundItemQuantity(entryQuantity(base) + entryQuantity(item));
      base.quantity = next;
      base.count = next;
      removeIdx.add(idx);
    }
  });

  if (removeIdx.size === 0) return backpack;
  return backpack.filter((_, idx: number) => !removeIdx.has(idx));
}
