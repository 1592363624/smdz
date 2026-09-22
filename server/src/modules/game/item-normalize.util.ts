/**
 * 物品身份规范化唯一出口。
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
// 装备品质码判定单一实现（equipment-ref.util），与装备栏展示 / 引用解析同源
import { equipmentQualityLabel } from './equipment-ref.util';

/** 静态定义查询接口（由 StaticDataService 适配实现） */
export interface ItemTypeLookup {
  /** 是否装备定义 */
  isEquipment(name: string): boolean;
  /** 物品定义的 type（无定义返回 undefined） */
  itemTypeName(name: string): string | undefined;
  /**
   * 装备定义的「特殊序号」（无定义返回 undefined）。
   * 可选成员：只需 type/堆叠语义的调用方（含测试桩）可以不提供，
   * backfillSpecialSeq 拿不到序号时按 0 处理，不会写坏条目。
   */
  equipmentSpecialSeq?(name: string): number | undefined;
}

/** 由 StaticDataService 适配出查询接口 */
export function lookupFromStaticData(staticData: any): ItemTypeLookup {
  return {
    isEquipment: (name: string) => !!staticData?.getEquipmentByName?.(name),
    itemTypeName: (name: string) => staticData?.getItemByName?.(name)?.type,
    equipmentSpecialSeq: (name: string) => {
      const raw = staticData?.getEquipmentByName?.(name)?.specialSeq;
      if (raw === undefined || raw === null || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    },
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

/** 读取条目数量（只读规范键 quantity，规范名见 field-contract.util.ts） */
function entryQuantity(item: any): number {
  const v = Number(item?.quantity ?? 0);
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
  const name = String(item?.name ?? '').trim();
  if (!name) return;

  const canonical = canonicalItemType(name, lookup, item?.type);
  if (canonical === '装备') {
    // 装备品质码不变量：原版唯一的装备构造入口是「生成装备」
    // （物品操作.ecode L1128-1261），其数据串恒为 `品质 + 加成转数据 + "!bx" + 特效`
    // —— 首字符必然是品质码（e/d/c/b/a/s），原版不存在无品质码的装备。
    // 因此入包出口在此兜底：数据串没有合法品质码时前置补最低档 E，保证
    // 「背包/装备栏里的装备一定带品质码」；⚠️ 正常路径（generateRewardEquipment）
    // 不会走到这里，触发即为上游写入漏洞，须修上游而非在此长期兜底。
    const rawData = String(item?.data ?? '');
    const entry: any = { ...item, name, type: '装备' };
    if (!equipmentQualityLabel(rawData)) {
      entry.data = 'e' + rawData;
    }
    backpack.push(entry);
    return;
  }

  const existing = backpack.find(
    (bp: any) =>
      String(bp?.name ?? '') === name &&
      String(bp?.type ?? '') !== '装备',
  );
  if (existing) {
    const next = roundItemQuantity(entryQuantity(existing) + entryQuantity(item));
    // 数量只写规范键 quantity：count/数量 等别名由 field-contract.util 在读档/落库边界
    // 统一收敛，此处不得写镜像字段——两个字段并存会互相打架。
    existing.quantity = next;
    // 自愈：存量条目若带历史脏 type（同名不同 type 分叉的根源），收敛到规范值
    if (existing.type !== canonical) {
      existing.type = canonical;
    }
    return;
  }

  const qty = roundItemQuantity(entryQuantity(item));
  backpack.push({ ...item, name, type: canonical, quantity: qty });
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
    const type = String(item.type ?? '');
    if (type === '装备') return;
    const name = String(item.name ?? '').trim();
    if (!name) return;

    const canonical = canonicalItemType(name, lookup, type || undefined);
    if (item.type !== canonical) {
      item.type = canonical;
    }

    const first = firstIndexByName.get(name);
    if (first === undefined) {
      firstIndexByName.set(name, idx);
    } else {
      const base = backpack[first];
      const next = roundItemQuantity(entryQuantity(base) + entryQuantity(item));
      base.quantity = next;
      removeIdx.add(idx);
    }
  });

  if (removeIdx.size === 0) return backpack;
  return backpack.filter((_, idx: number) => !removeIdx.has(idx));
}

/**
 * 按静态定义补齐装备/武器条目的「特殊序号」（幂等、就地写派生字段、不换数组引用）。
 *
 * 为什么要在读档闸做：存档里的装备/武器条目通常只落
 * `{name,type,quantity,durability,data}`（见 item.service 穿戴、掉落生成），
 * 而 `加成计算` 与战斗链路里绝大多数装备效果是**按 特殊序号 判定**的
 *（棒棒糖97、射爆核心29、叹息之墙12、纳米注喷器13、心形贴103、丝袜系列59-62/118、
 * 植入体/增幅器的"排除自身"分支…）。不补齐时这些判定对真实玩家恒为假，
 * 只有少数额外写了名称匹配的分支侥幸生效 —— 表现为"描述里的效果实际没生效"。
 *
 * 就地写而不返回新数组：Prisma Json 列读出的是同一份数组引用，调用方改哪侧都等价；
 * 换引用会让 installCanonicalAccessors 的权威态与本地快照分叉。
 * 已显式带 specialSeq 的条目（新档/测试构造）原样尊重，不覆盖。
 */
export function backfillSpecialSeq(list: any, lookup: ItemTypeLookup): any {
  if (!Array.isArray(list)) return list;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.specialSeq !== undefined && item.specialSeq !== null) continue;
    const name = String(item.name ?? '');
    if (!name) continue;
    const seq = lookup?.equipmentSpecialSeq?.(name);
    if (seq !== undefined) item.specialSeq = seq;
  }
  return list;
}
