/**
 * 字段规范契约（SSOT）：历史别名 / 中文字段 → 英文规范键的唯一映射表 + 持久化边界归一化器。
 * 任何位置的读写口径一律以本表为准，禁止业务模块自建别名兜底；规范键一律英文，
 * 中文只保留在「内容语义」上（加成属性名、标记名、道具名等**值**不动）。
 */

/** 物品条目（背包 / 装备 / 武器 / 安全箱 / 掉落物 / 载具零件 / 红包道具 / 商店商品） */
export const ITEM_ALIASES: Record<string, string> = {
  名称: 'name',
  类型: 'type',
  数量: 'quantity',
  数据: 'data',
  耐久: 'durability',
  制造者: 'maker',
  耐久等级: 'durabilityLevel',
};

/** 物品域同义英文键合并表（旧键 → 规范键）：count 与 quantity 语义完全相同。 */
export const ITEM_MERGES: Record<string, string> = {
  count: 'quantity',
};

/** 增益 / 限时标记条目（markers2 / buffs 数组元素） */
export const BUFF_ALIASES: Record<string, string> = {
  名称: 'name',
  强度: 'strength',
  有效期至: 'expireAt',
  是否叠加时间: 'stackTime',
};

/** 增益域同义英文键合并表（旧键 → 规范键）：value 与 strength 同义。 */
export const BUFF_MERGES: Record<string, string> = {
  value: 'strength',
};

/** 载具（地图 vehicles 条目 / GameVehicle 行）：字段名与原版 载具 结构对齐 */
export const VEHICLE_ALIASES: Record<string, string> = {
  名称: 'name',
  类型: 'type',
  编号: 'vehicleId',
  归属: 'owner',
  驾驶员: 'driver',
  行走方式: 'moveType',
  当前生命: 'currentHp',
  生命: 'maxHp',
  上限: 'slotStatus',
  武器: 'weaponSlots',
  武器上限: 'maxWeapon',
  防御: 'defenseSlots',
  防御上限: 'maxDefense',
  功能: 'functionSlots',
  功能上限: 'maxFunction',
  行走: 'moveSlots',
  行走上限: 'maxMove',
  加成: 'bonus',
  零件: 'parts',
  内置零件: 'builtinParts',
  配方: 'recipes',
  数值: 'value',
  标记: 'markers',
  标记2: 'markers2',
  涂层: 'coating',
  逆转力场: 'reverseField',
  发丝: 'hair',
  唤醒者: 'sealWaker',
  封印中: 'sealed',
  封印等级: 'sealLevel',
  需求等级: 'requireLevel',
  守卫波数: 'guardWaves',
  当前守卫波: 'sealWave',
  献祭凭证: 'sacrificeVouchers',
  献祭活力: 'sacrificeVitality',
};

/** 召唤物 / 地图怪物条目（地图 summons / monsters 运行时视图） */
export const SUMMON_ALIASES: Record<string, string> = {
  名称: 'name',
  类型: 'type',
  当前生命: 'hp',
  当前护盾: 'shield',
  当前装甲: 'armor',
  生命: 'maxHp',
  护盾: 'maxShield',
  装甲: 'maxArmor',
  归属: 'ownerQQ',
  特殊序号: 'specialSeq',
  技能等级: 'skillLevel',
  等级: 'level',
  图片: 'image',
  好感: 'affinity',
  活力: 'vitality',
  经验: 'exp',
  加成: 'bonus',
  基础加成: 'baseBonus',
  额外加成: 'extraBonus',
  标记: 'markers',
  标记2: 'markers2',
  增益: 'buffs',
  装备: 'equipments',
  武器: 'weapons',
  当前武器: 'currentWeapon',
  装备预设: 'equipmentPresets',
  成就: 'achievements',
  背包: 'backpack',
};

/**
 * 标记 / 成就条目（markers 数组元素、achievements 数组）：统一为 `{name, value}`。
 *
 * ⚠️ 仅适用于**数组形态**的条目；`markers` 若为字典 `{ 标记名: 数值 }`，
 * 字典键就是标记名本身（内容语义），绝不能按本表收敛。
 */
export const MARKER_ALIASES: Record<string, string> = {
  名称: 'name',
  数值: 'value',
};

/** 地图资源点 / 建筑条目（地图 resources / resources2 / buildings） */
export const MAP_RESOURCE_ALIASES: Record<string, string> = {
  名称: 'name',
  类型: 'type',
  数量: 'quantity',
  耐久: 'durability',
  产出: 'outputs',
  产出2: 'outputs2',
  消耗: 'inputs',
  采集指令: 'gatherCmd',
  采集文本: 'gatherText',
  代发言: 'proxySpeak',
  不占: 'noOccupy',
  几率: 'chance',
  次数: 'times',
  说明: 'description',
  加成: 'bonus',
};

/**
 * 地图资源/建筑域同义英文键合并表（旧键 → 规范键）：count → quantity。
 * 静态配置与旧存档仍带 count，必须在进入计算前归一化；归一化后直接读 count 拿到的是 undefined。
 */
export const MAP_RESOURCE_MERGES: Record<string, string> = {
  count: 'quantity',
};

/** 归一化域标识 */
export type FieldDomain =
  | 'item'
  | 'buff'
  | 'vehicle'
  | 'summon'
  | 'mapResource'
  | 'marker';

/**
 * 每个域一张「旧键 → 规范键」查找表（含同义英文键合并）。
 *
 * 实现取向：按**条目自身的键**去查表（条目通常 5~10 个键），而不是按别名表
 * 逐项 hasOwnProperty（载具域别名 30+ 个）。归一化器挂在 Prisma 中间件上，
 * 每次读写都会跑，必须保持低成本。
 */
const DOMAIN_LOOKUP: Record<FieldDomain, Map<string, string>> = buildLookups();

function buildLookups(): Record<FieldDomain, Map<string, string>> {
  const make = (aliases: Record<string, string>, merges?: Record<string, string>) => {
    const m = new Map<string, string>();
    if (merges) for (const [legacy, canonical] of Object.entries(merges)) m.set(legacy, canonical);
    for (const [legacy, canonical] of Object.entries(aliases)) m.set(legacy, canonical);
    return m;
  };
  return {
    item: make(ITEM_ALIASES, ITEM_MERGES),
    buff: make(BUFF_ALIASES, BUFF_MERGES),
    vehicle: make(VEHICLE_ALIASES),
    summon: make(SUMMON_ALIASES),
    mapResource: make(MAP_RESOURCE_ALIASES, MAP_RESOURCE_MERGES),
    marker: make(MARKER_ALIASES),
  };
}

/**
 * 就地归一化一个条目的字段名（把历史别名收敛成英文规范键）。
 *
 * 收敛规则：规范键已存在 → 以规范键为准，删除旧键（旧键是脏镜像）；
 * 规范键缺失 → 旧键的值迁到规范键，再删除旧键。
 *
 * @param obj 条目对象（非对象/数组时原样返回 false）
 * @param domain 归属域，决定使用哪张别名表
 * @returns 是否发生了改动（供迁移脚本统计与断言使用）
 */
export function normalizeEntryKeys(obj: any, domain: FieldDomain): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const lookup = DOMAIN_LOOKUP[domain];
  let changed = false;

  for (const key of Object.keys(obj)) {
    const canonical = lookup.get(key);
    if (canonical === undefined) continue;
    // 规范键缺失时才迁移旧键的值；无论是否冲突，旧键一律删除，保证归一化后不再出现旧键
    if (obj[canonical] === undefined) obj[canonical] = obj[key];
    delete obj[key];
    changed = true;
  }

  return changed;
}

/** 就地归一化一组条目（数组或对象字典）；返回是否发生了改动。 */
export function normalizeEntryList(list: any, domain: FieldDomain): boolean {
  if (!list || typeof list !== 'object') return false;
  const arr = Array.isArray(list) ? list : Object.values(list);
  let changed = false;
  for (const it of arr) {
    if (normalizeEntryKeys(it, domain)) changed = true;
  }
  return changed;
}

/**
 * 归一化 markers / achievements 容器：`[{名称,数值}]` / `[{name,数值}]` → `[{name,value}]`。
 * 字典形态 `{ 标记名: 数值 }` 的键是标记名（内容语义），一律不动。
 */
export function normalizeMarkers(markers: any): boolean {
  return Array.isArray(markers) ? normalizeEntryList(markers, 'marker') : false;
}

/**
 * 读取标记数值（标记读取的唯一口径）。
 *
 * 支持两种规范形态：字典 `{ 标记名: 数值 }` 与数组 `[{ name, value }]`。
 * 旧别名（名称/数值）不在此兜底，调用前必须先过边界归一化器（normalizeMarkers）。
 *
 * @param markers markers 容器（数组或字典，允许为空/非法值）
 * @returns 数值（取不到或非法时返回 0）
 */
export function readMarkerValue(markers: any, name: string): number {
  if (!markers) return 0;
  if (Array.isArray(markers)) {
    const hit = markers.find((it: any) => it && (it.name === name));
    return Number(hit?.value) || 0;
  }
  if (typeof markers === 'object') return Number((markers as any)[name]) || 0;
  return 0;
}

/**
 * 写出标记数值（标记写入的唯一口径，原地修改，数组/字典均可）。
 *
 * 数组形态统一写 `{ name, value }`；已存在同名项就地覆盖，不存在则追加。
 * 字典形态直接按键赋值。
 *
 * @param markers markers 容器（数组或字典）
 * @returns 是否发生了写入（容器非法时返回 false）
 */
export function writeMarkerValue(markers: any, name: string, value: number): boolean {
  if (Array.isArray(markers)) {
    const hit = markers.find((it: any) => it && it.name === name);
    if (hit) hit.value = value;
    else markers.push({ name, value });
    return true;
  }
  if (markers && typeof markers === 'object') {
    (markers as any)[name] = value;
    return true;
  }
  return false;
}

/**
 * 容器字段若是 JSON 字符串则先解析成原生对象/数组（历史存量与部分写路径仍可能写入字符串）。
 * 解析成功会原地改写 entity[field]，保证后续 normalizeEntryList 能吃到数组形态。
 * @returns 是否发生了「字符串→原生」形态变化
 */
function coerceJsonField(entity: any, field: string): boolean {
  const value = entity?.[field];
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '[' && trimmed[0] !== '{')) return false;
  try {
    entity[field] = JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 归一化「拥有物品容器 + 增益容器」的实体（玩家 / 怪物 / 召唤物通用骨架）。
 * 物品容器：backpack/safeBox/equipment/weapons/equipmentPresets → item 域
 * 增益容器：markers2/buffs → buff 域
 * 标记容器：markers/achievements → marker 域（仅数组形态；字典形态保留标记名键）
 */
export function normalizeOwnedContainers(entity: any): boolean {
  if (!entity || typeof entity !== 'object') return false;
  let changed = false;
  for (const f of ['backpack', 'safeBox', 'equipment', 'weapons', 'equipmentPresets']) {
    if (coerceJsonField(entity, f)) changed = true;
    if (normalizeEntryList(entity[f], 'item')) changed = true;
  }
  for (const f of ['markers2', 'buffs']) {
    if (coerceJsonField(entity, f)) changed = true;
    if (normalizeEntryList(entity[f], 'buff')) changed = true;
  }
  for (const f of ['markers', 'achievements']) {
    if (coerceJsonField(entity, f)) changed = true;
    if (normalizeMarkers(entity[f])) changed = true;
  }
  return changed;
}

/**
 * 归一化载具条目：先收敛载具自身字段，再下钻零件（parts/builtinParts，物品域）、
 * 生产配方（recipes：{名称,数值} → {name,value}）与限时标记（markers2，增益域）。
 */
export function normalizeVehicleEntry(vehicle: any): boolean {
  if (!vehicle || typeof vehicle !== 'object') return false;
  let changed = normalizeEntryKeys(vehicle, 'vehicle');
  if (normalizeEntryList(vehicle.parts, 'item')) changed = true;
  if (normalizeEntryList(vehicle.builtinParts, 'item')) changed = true;
  if (normalizeEntryList(vehicle.recipes, 'vehicle')) changed = true;
  if (normalizeEntryList(vehicle.markers2, 'buff')) changed = true;
  return changed;
}

/**
 * 归一化召唤物条目：自身字段（召唤物域）+ 自带物品/增益容器。
 */
export function normalizeSummonEntry(summon: any): boolean {
  if (!summon || typeof summon !== 'object') return false;
  let changed = normalizeEntryKeys(summon, 'summon');
  if (normalizeOwnedContainers(summon)) changed = true;
  return changed;
}

/**
 * 归一化玩家行（PlayerService 读档 / 落库唯一闸口调用）。
 * 覆盖：物品容器（背包/安全箱/装备/武器/预设）、增益容器（标记2/增益）。
 * 货币（钻石/召唤券/数据核心）以独立列为真源，背包内的镜像由 materializeCurrencies 处理。
 */
export function normalizePlayerRow(player: any): boolean {
  return normalizeOwnedContainers(player);
}

/** 地图行中需要归一化的列 → 归属域 */
const MAP_LIST_COLUMNS: Array<{ field: string; domain: FieldDomain }> = [
  { field: 'items', domain: 'item' },
  { field: 'resources', domain: 'mapResource' },
  { field: 'resources2', domain: 'mapResource' },
  { field: 'buildings', domain: 'mapResource' },
  { field: 'markers2', domain: 'buff' },
];

/**
 * 归一化资源/建筑条目：顶层字段 + 下钻 outputs/outputs2/requirements 内的
 * 数量键（count→quantity）。概率键 chance 不参与别名表（content/配置语义）。
 */
export function normalizeMapResourceEntry(entry: any): boolean {
  if (!entry || typeof entry !== 'object') return false;
  let changed = normalizeEntryKeys(entry, 'mapResource');
  for (const field of ['outputs', 'outputs2', 'requirements'] as const) {
    if (normalizeEntryList(entry[field], 'mapResource')) changed = true;
  }
  return changed;
}

/**
 * 归一化地图行（GameMap）：可拾取物品 / 资源点 / 建筑 / 限时标记 直接按域收敛；
 * 载具、召唤物条目按各自规则连带下钻其内部容器。
 */
export function normalizeMapRow(map: any): boolean {
  if (!map || typeof map !== 'object') return false;
  let changed = false;
  for (const { field, domain } of MAP_LIST_COLUMNS) {
    if (coerceJsonField(map, field)) changed = true;
    if (domain === 'mapResource') {
      for (const entry of asArray(map[field])) {
        if (normalizeMapResourceEntry(entry)) changed = true;
      }
      continue;
    }
    if (normalizeEntryList(map[field], domain)) changed = true;
  }
  if (coerceJsonField(map, 'markers')) changed = true;
  if (coerceJsonField(map, 'vehicles')) changed = true;
  if (coerceJsonField(map, 'summons')) changed = true;
  if (normalizeMarkers(map.markers)) changed = true;
  for (const v of asArray(map.vehicles)) {
    if (normalizeVehicleEntry(v)) changed = true;
  }
  for (const s of asArray(map.summons)) {
    if (normalizeSummonEntry(s)) changed = true;
  }
  return changed;
}

/**
 * 归一化怪物行（GameMonster）：自带物品容器与增益容器；
 * markers/achievements/set 的键为语义标记名，不动。
 */
export function normalizeMonsterRow(monster: any): boolean {
  return normalizeOwnedContainers(monster);
}

/** 归一化载具行（GameVehicle）：自身 JSON 列与地图载具条目同构，复用 normalizeVehicleEntry。 */
export function normalizeVehicleRow(vehicle: any): boolean {
  return normalizeVehicleEntry(vehicle);
}

/** 数组化辅助（非数组返回空数组，避免调用方到处判空） */
function asArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}