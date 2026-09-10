/**
 * 网页左栏装备栏快照结构门禁（2026-09-09 用户约定）
 *
 * 约定：装备栏**固定 15 格**（12 部位 + 武器 + 植入 + 增幅），背上备用武器**不展开为独立格**
 * （初版曾把背上武器展开成 背上1..N 格把列表撑爆，用户明确要求回到 15 格）；
 * 全部武器详情挂在「武器」格 weapons 子字段，前端单击「武器」格才展开列表。
 * 每件武器带已装备序号 no（与「信息」文本面板/unequipItem 编号分支三处同源）。
 */
import { GameService } from '../src/modules/game/game.service';
import { ItemService } from '../src/modules/game/item.service';

function makeService(player: any) {
  const service = Object.create(GameService.prototype) as any;
  const staticData = {
    getEquipmentByName: (name: string) =>
      name === '布衣'
        ? { equipType: '上身', specialSeq: 1 }
        : { equipType: '武器', specialSeq: -3, cooldown: 5 },
  };
  service.staticData = staticData;
  service.combatState = {
    getAchievementProficiency: () => 0,
    setJudgment: () => {},
  };
  service.itemSystemService = { formatBonusStats: () => [] };
  const itemService = Object.create(ItemService.prototype) as any;
  itemService.logger = { warn: () => {}, log: () => {}, error: () => {} };
  itemService.staticData = staticData;
  itemService.playerService = {};
  itemService.combatState = service.combatState;
  service.itemService = itemService;
  return service;
}

const weapon = (data: string) => ({ name: '纵横', type: '装备', quantity: 1, durability: 100, data });

describe('buildEquipmentSnapshot 15 格约定 + 武器格 weapons 子字段', () => {
  it('多把背上武器时快照仍恒 15 格；武器详情全部挂在「武器」格 weapons 子数组', () => {
    const player = {
      equipment: [{ name: '布衣', type: '装备', data: 'c' }],
      weapons: [weapon('s'), weapon('c'), weapon('a')],
      currentWeapon: 2, // 手持第 2 把
    };
    const snap = makeService(player).buildEquipmentSnapshot(player, {});

    // 15 格：12 部位 + 武器 + 植入 + 增幅，无背上N格
    expect(snap).toHaveLength(15);
    expect(snap.map((e) => e.slot)).toEqual([
      '头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部',
      '武器', '植入', '增幅',
    ]);

    // 武器格 = 手持那把（第 2 把，data 'c'），带 weapons 子数组
    const weaponCell = snap.find((e) => e.slot === '武器')!;
    expect(weaponCell.name).toBe('纵横');
    // 品质下发**品质码字母**（2026-09-10 口径统一，与背包显示名「纵横C」同源）：'c' → C
    expect(weaponCell.quality).toBe('C');
    expect(Array.isArray(weaponCell.weapons)).toBe(true);

    // 列表顺序：手持在前，其余按 weapons[] 序；序号与 buildEquippedList 同源
    // （已装备序号：1=上身，2=武器（手持），3=背上（第1把），4=背上（第3把））
    const list = weaponCell.weapons!;
    expect(list.map((w) => `${w.slot}#${w.no}`)).toEqual(['武器#2', '背上#3', '背上#4']);
    expect(list[0].quality).toBe('C'); // 'c' → C
    expect(list[1].quality).toBe('S'); // 's' → S（传说）
    expect(list[2].quality).toBe('A'); // 'a' → A（史诗）
  });

  it('空手玩家：武器格回拳头占位（name=null），weapons 为空数组', () => {
    const player = {
      equipment: [],
      weapons: [],
      currentWeapon: 0,
    };
    const snap = makeService(player).buildEquipmentSnapshot(player, {});
    expect(snap).toHaveLength(15);
    const weaponCell = snap.find((e) => e.slot === '武器')!;
    expect(weaponCell.name).toBeNull();
    expect(weaponCell.weapons).toEqual([]);
  });
});
