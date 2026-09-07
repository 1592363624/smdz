/**
 * 装备特效解析（展示与战斗共用的唯一实现）
 *
 * 对应原版：物品操作.ecode L1438-1475「解析装备」的 bx 段。原版在解析装备数据串时
 * 就地完成特效结算，因此**特效加成随装备的「自带加成」一起参与后续全部属性计算**。
 * 复刻版曾把这段逻辑只放在 ItemService.parseEquipment（展示路径），战斗路径另起炉灶，
 * 导致「面板看得到、打架打不出」。本工具把该逻辑抽成纯函数，供展示与战斗两侧共用，
 * 消除两套实现漂移的风险。
 *
 * 原版语义（逐条对应）：
 *   L1442-1454  武器专属伤害属性缩放：37 全系×1.15 / 38 物×1.25 /
 *               39 物=火×1.25（原版疑似笔误，按原版保留）/ 40 物=冰×1.25 / 41 物=电×1.25
 *   L1458-1467  武器：z.特效=b；叠加加成(z.自带, 武器特效[b].加成)；
 *               z.冷却 += 武器特效[b].加成.冷却；
 *               攻击次数>=2 时 z.加成.攻击次数 += (攻击次数-1)；
 *               攻击文本非空时覆盖 z.攻击文本
 *   L1472-1474  装备（非武器）：z.特效=b；叠加加成(z.自带, 装备特效[b].加成)，无冷却/攻击次数/攻击文本
 *
 * 注意：特效编号在「武器特效池」与「装备特效池」中各自从 1 开始编号，
 * 由调用方通过 StaticDataService.getEffectById(id, isWeapon) 取得所在池的条目。
 */

/** 特效作用目标：调用方传入可变副本，函数原地结算 */
export interface EquipmentEffectTarget {
  /** 伤害属性（物/火/冰/电），37-41 号特效会原地缩放 */
  properties: { phys: number; fire: number; ice: number; elec: number };
  /** 武器冷却（秒），特效可追加（仅武器） */
  cooldown: number;
  /** 自带加成（原版 z.自带）：特效加成整体叠加于此 */
  selfBonus: Record<string, number>;
  /** 附加加成（原版 z.加成）：攻击次数写入于此 */
  attackBonus: Record<string, number>;
  /** 攻击文本：特效指定时覆盖 */
  attackText?: any;
  /** 实际生效的特效编号；编号越界（池内不存在）时为 0 */
  specialEffect: number;
  /** 战斗语义标记，供攻击链路消费 */
  flags: { aoe: boolean; mustHit: boolean };
}

export function createEffectTarget(properties?: Partial<EquipmentEffectTarget['properties']>, cooldown = 0): EquipmentEffectTarget {
  return {
    properties: {
      phys: Number(properties?.phys ?? 0),
      fire: Number(properties?.fire ?? 0),
      ice: Number(properties?.ice ?? 0),
      elec: Number(properties?.elec ?? 0),
    },
    cooldown: Number(cooldown) || 0,
    selfBonus: {},
    attackBonus: {},
    attackText: undefined,
    specialEffect: 0,
    flags: { aoe: false, mustHit: false },
  };
}

function toNum(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 应用装备特效。
 *
 * @param target 作用目标（原地修改）
 * @param effect 特效池条目（StaticDataService.getEffectById 的返回值），越界时为 undefined
 * @param isWeapon 是否武器（决定缩放/冷却/攻击次数/攻击文本是否生效）
 * @param effectId data 串中的 bx 编号
 */
export function applyEquipmentEffect(
  target: EquipmentEffectTarget,
  effect: any | undefined,
  isWeapon: boolean,
  effectId: number,
): void {
  const b = Math.trunc(toNum(effectId));
  if (b <= 0) return;

  // L1442-1454：伤害属性缩放发生在「池内编号是否存在」判断之前，故越界编号依然缩放。
  if (isWeapon) {
    const p = target.properties;
    switch (b) {
      case 37: // 天行践：全系×1.15
        p.phys *= 1.15; p.fire *= 1.15; p.ice *= 1.15; p.elec *= 1.15;
        break;
      case 38: // 引力弹头：物×1.25
        p.phys *= 1.25;
        break;
      case 39: // 龙之吐息：物 = 火×1.25（原版疑似笔误，按原版保留）
        p.phys = p.fire * 1.25;
        break;
      case 40: // 灵魂之息：物 = 冰×1.25
        p.phys = p.ice * 1.25;
        break;
      case 41: // 球状闪电：物 = 电×1.25
        p.phys = p.elec * 1.25;
        break;
      default:
        break;
    }
  }

  // L1458 / L1472：编号必须在池内才写入特效编号与加成
  if (!effect) return;
  target.specialEffect = b;

  // 存量数据文件/旧存档中 bonus 可能是 JSON 文本，统一归一为对象
  let bonus: Record<string, any> = (effect as any)?.bonus ?? (effect as any)?.加成 ?? {};
  if (typeof bonus === 'string') {
    try { bonus = JSON.parse(bonus) as Record<string, any>; } catch { bonus = {}; }
  }
  for (const [key, raw] of Object.entries(bonus)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value === 0) continue; // 非数值字段（如攻击文本）不进加成
    target.selfBonus[key] = (target.selfBonus[key] || 0) + value;
  }

  if (isWeapon) {
    // L1461：原版取「冷却」；本作 effects.json 使用「攻击冷却」，两者兼容
    target.cooldown += toNum(bonus['冷却'] ?? bonus['攻击冷却']);
    // L1462-1463：仅当特效攻击次数>=2 时按 (n-1) 追加（原版字面条件）
    const attackCount = toNum(bonus['攻击次数']);
    if (attackCount >= 2) {
      target.attackBonus['攻击次数'] = (target.attackBonus['攻击次数'] || 0) + attackCount - 1;
    }
    // L1465-1466：攻击文本非空则覆盖
    const text = bonus['攻击文本'];
    if (typeof text === 'string' && text !== '') target.attackText = text;
  }

  target.flags.aoe = toNum(bonus['aoe']) > 0;
  target.flags.mustHit = toNum(bonus['必中']) > 0;
}

/**
 * 从装备 data 编码串中取出 bx 特效编号。
 * data 形如 "S!aa30!bx3!@@制造者"，未携带 bx 段时返回 0。
 */
export function parseEffectIdFromData(data: any): number {
  const raw = String(data ?? '');
  if (!raw) return 0;
  for (const segment of raw.split('!')) {
    if (segment.length < 3) continue;
    if (segment.substring(0, 2) === 'bx') {
      const n = parseInt(segment.substring(2), 10);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}
