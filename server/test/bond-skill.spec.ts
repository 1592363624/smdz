/**
 * 羁绊技能表（bond-skill.util）一致性守护测试。
 *
 * 背景：该表原为「战斗 {id,name} 表 + 指令 {id,name,desc} 表 + 武器类型局部数组」三份平行定义，
 * 彼此靠数组顺序隐式对齐（一处用下标、一处用 find），改动任一处都不会报错，只会静默错配
 * （面板显示、+15% 加成目标、战斗回包文本三方不一致）。
 * 收敛为单一真相源后，本用例守住三条不变量：
 *   1. bj1 表的 desc 文案与 weaponType 字段一致（防止改名只改一处）；
 *   2. bj2 表的 id 与 BOND_SKILL_B_ID 常量一致（防止消费点裸数字与表漂移）；
 *   3. 查表函数对 0 / 越界值回退为「未指定」/ ''（面板与战斗文本的兜底口径）。
 */
import {
  BOND_COOLDOWN_KEY,
  BOND_SKILL_A,
  BOND_SKILL_A_ATTACK_BONUS,
  BOND_SKILL_B,
  BOND_SKILL_B_ID,
  BOND_SILENCER_COOLDOWN_SEC,
  BOND_SILENCER_DAMAGE_RATIO,
  bondMarkerKey,
  bondSkillList,
  bondSkillName,
  bondWeaponType,
} from '../src/modules/game/bond-skill.util';

describe('羁绊技能表：单一真相源一致性', () => {
  it('bj1 表：id 连续 1..5，desc 中的武器类型与 weaponType 字段一致', () => {
    expect(BOND_SKILL_A.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
    for (const skill of BOND_SKILL_A) {
      expect(skill.desc).toContain(skill.weaponType);
      expect(skill.desc).toContain('0.15倍');
    }
  });

  it('bj1 表：加成值与原版口径一致（属性.攻击2 +15）', () => {
    expect(BOND_SKILL_A_ATTACK_BONUS).toBe(15);
  });

  it('bj2 表：id 与 BOND_SKILL_B_ID 常量一一对应（生存之道=2）', () => {
    expect(BOND_SKILL_B.map((s) => s.id)).toEqual([
      BOND_SKILL_B_ID.PET_SEARCH,
      BOND_SKILL_B_ID.SILENCER,
      BOND_SKILL_B_ID.SKILL_EXP,
    ]);
    expect(BOND_SKILL_B_ID.SILENCER).toBe(2);
  });

  it('生存之道数值常量与原版一致（15% 倍率 / 30 秒冷却）', () => {
    expect(BOND_SILENCER_DAMAGE_RATIO).toBe(0.15);
    expect(BOND_SILENCER_COOLDOWN_SEC).toBe(30);
  });

  it('查表函数：0 与越界值回退「未指定」/ 空武器类型', () => {
    expect(bondSkillName('a', 1)).toBe('利器管理');
    expect(bondSkillName('a', 0)).toBe('未指定');
    expect(bondSkillName('a', 99)).toBe('未指定');
    expect(bondSkillName('b', BOND_SKILL_B_ID.SILENCER)).toBe('生存之道');
    expect(bondSkillName('b', 0)).toBe('未指定');
    expect(bondWeaponType(2)).toBe('射弹武器');
    expect(bondWeaponType(0)).toBe('');
    expect(bondWeaponType(99)).toBe('');
  });

  it('标记键与改动冷却键口径固定（bj1/bj2、gbj1/gbj2）', () => {
    expect(bondMarkerKey('a')).toBe('bj1');
    expect(bondMarkerKey('b')).toBe('bj2');
    expect(BOND_COOLDOWN_KEY.a).toBe('gbj1');
    expect(BOND_COOLDOWN_KEY.b).toBe('gbj2');
  });

  it('bondSkillList 与槽位对应（bj1 表 5 项 / bj2 表 3 项）', () => {
    expect(bondSkillList('a').length).toBe(5);
    expect(bondSkillList('b').length).toBe(3);
  });
});
