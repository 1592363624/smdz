/**
 * 白的羁绊技能表（原版 _主程序.ecode L10732-10811「控制终端」分支）—— 单一真相源。
 *
 * 消费方：技能面板展示（SkillCommandService）、战斗加成与文本（CombatSystemService）、
 * 宠物搜索 / 技能经验倍率（FamiliarSkillsService）。
 * 禁止在消费点重新硬编码技能名、武器类型或技能 id：此前曾存在「战斗表 {id,name} + 指令表
 * {id,name,desc} + 武器类型局部数组」三份平行定义，彼此靠数组顺序隐式对齐（一处用下标、
 * 一处用 find），改动任一处都不会报错，只会静默错配（面板显示、加成目标、回包文本三方不一致）。
 *
 * 标记口径：bj1 = 技能1 的 id，bj2 = 技能2 的 id，0 表示未指定。
 */

/** 技能1（控制终端技能a）：按当前武器类型提高攻击。id 即标记 bj1 的值。 */
export const BOND_SKILL_A: ReadonlyArray<{
  id: number;
  name: string;
  desc: string;
  /** 加成判定用的武器类型（原版 加成计算.ecode L2245-2287：与当前武器类型匹配才生效）。 */
  weaponType: string;
}> = [
  { id: 1, name: '利器管理', desc: '羁绊者使用近战武器时攻击提高0.15倍', weaponType: '近战武器' },
  { id: 2, name: '弹道分析', desc: '羁绊者使用射弹武器时攻击提高0.15倍', weaponType: '射弹武器' },
  { id: 3, name: '能量稳定', desc: '羁绊者使用能量武器时攻击提高0.15倍', weaponType: '能量武器' },
  { id: 4, name: '燃料优化', desc: '羁绊者使用制导武器时攻击提高0.15倍', weaponType: '制导武器' },
  { id: 5, name: '幽能亲和', desc: '羁绊者使用幽能武器时攻击提高0.15倍', weaponType: '幽能武器' },
];

/** 技能1 命中武器类型时的加成：属性.攻击2 += 15（原版 加成计算.ecode L2245-2287）。 */
export const BOND_SKILL_A_ATTACK_BONUS = 15;

/** 技能2（控制终端技能b）的技能 id：消费点禁止再用裸数字比较。 */
export const BOND_SKILL_B_ID = {
  /** 宠物饲养：宠物搜索得到的物品 +20% */
  PET_SEARCH: 1,
  /** 生存之道：远程武器附带 15% 随机属性伤害且攻击视为隐匿（30 秒冷却） */
  SILENCER: 2,
  /** 贴心助手：使魔技能得到的经验 +25% */
  SKILL_EXP: 3,
} as const;

/** 技能2（控制终端技能b）：id 即标记 bj2 的值。 */
export const BOND_SKILL_B: ReadonlyArray<{ id: number; name: string; desc: string }> = [
  { id: BOND_SKILL_B_ID.PET_SEARCH, name: '宠物饲养', desc: '羁绊者的宠物搜索得到的物品+20%' },
  { id: BOND_SKILL_B_ID.SILENCER, name: '生存之道', desc: '为羁绊者的远程武器安装一个带特殊加速轨道的消音器，羁绊者使用远程武器攻击时附带攻击伤害的15%随机属性伤害，攻击为隐匿攻击，冷却30秒' },
  { id: BOND_SKILL_B_ID.SKILL_EXP, name: '贴心助手', desc: '羁绊者使用技能得到的经验+25%' },
];

/** 「生存之道」追加伤害倍率（原版 战斗相关.ecode L2990：剩余总伤害 × 0.15）。 */
export const BOND_SILENCER_DAMAGE_RATIO = 0.15;

/** 「生存之道」冷却秒数（原版 时间间隔要求("xyq", 30, 攻击方.标记2, …)）。 */
export const BOND_SILENCER_COOLDOWN_SEC = 30;

/** 「生存之道」冷却标记名（写在 标记2 上的键名，原版 战斗相关.ecode L2988）。 */
export const BOND_SILENCER_COOLDOWN_KEY = 'xyq';

/** 技能槽 → 改动冷却标记名（原版 时间间隔要求("gbj1"/"gbj2", 有效期当天(), …)）。 */
export const BOND_COOLDOWN_KEY = { a: 'gbj1', b: 'gbj2' } as const;

/** 羁绊技能槽（a = 技能1，b = 技能2）。 */
export type BondSkillSlot = 'a' | 'b';

/** 技能槽 → 标记键（bj1 / bj2）。 */
export function bondMarkerKey(slot: BondSkillSlot): string {
  return slot === 'a' ? 'bj1' : 'bj2';
}

/** 技能槽 → 候选表（唯一查表入口）。 */
export function bondSkillList(slot: BondSkillSlot): ReadonlyArray<{ id: number; name: string; desc: string }> {
  return slot === 'a' ? BOND_SKILL_A : BOND_SKILL_B;
}

/** 标记值 → 技能名（0 / 越界 → 未指定）。技能面板展示与战斗回包文本共用。 */
export function bondSkillName(slot: BondSkillSlot, value: number): string {
  const id = Number(value) || 0;
  if (!id) return '未指定';
  return bondSkillList(slot).find((skill) => skill.id === id)?.name ?? '未指定';
}

/** bj1 → 对应武器类型（+15% 加成判定）；0 / 越界 → ''。 */
export function bondWeaponType(bj1: number): string {
  const id = Number(bj1) || 0;
  if (id <= 0) return '';
  return BOND_SKILL_A.find((skill) => skill.id === id)?.weaponType ?? '';
}
