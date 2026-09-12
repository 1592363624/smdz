/**
 * 装备强化可见性门禁（2026-09-10）
 *
 * 用户实测：武器「强化 +0」与「+2」的装备详情属性完全一致，无法判断强化是否生效、
 * 到底得到了哪些属性。根因是**展示链**从未接入强化——左侧装备栏/武器详情只读
 * `parseEquipment` 的原始自带/加成，而战斗链 `buildAttackerBonus` 早已调 `calcEquipReinforce`。
 *
 * 本套用例锁定三条不变量：
 *   1) 展示链属性 = 强化后口径，且增量以 `(+x.xx)` 标注；
 *   2) 强化系数由 `calcEquipReinforce` 单一出口返回（禁调用方自行重算 a1）；
 *   3) 增幅器不参与装备强化（原版 加成计算.ecode L1669 明确跳过）。
 */
import { GameService } from '../src/modules/game/game.service';
import { ItemService } from '../src/modules/game/item.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

// data 用占位串 'x'：只让 parseEquipment 走「静态表 hydrate」路径，
// 属性全部来自静态定义 baseBonus，便于按原版口径手算期望值。
const DEFS: Record<string, any> = {
  提卡: { equipType: '武器', baseBonus: { 火伤: 7.86, 装甲: 6.72, 命中: 3.66, 掉落率: 1.11 } },
  加固腿甲: { equipType: '腿部', baseBonus: { 装甲: 6.72 } },
  增幅核心: { equipType: '增幅器', baseBonus: { 攻击: 100 } },
};

const markerReader = (markers: any, key: string): number => {
  const parsed = typeof markers === 'string' ? JSON.parse(markers || '{}') : markers || {};
  return Number(parsed[key]) || 0;
};

function makeGameService() {
  const staticData = { getEquipmentByName: (name: string) => DEFS[name] };

  const itemService = Object.create(ItemService.prototype) as any;
  itemService.logger = { warn: () => {}, log: () => {}, error: () => {} };
  itemService.staticData = staticData;
  itemService.playerService = {};
  itemService.combatState = { getAchievementProficiency: markerReader, setJudgment: () => {} };

  const itemSystemService = Object.create(ItemSystemService.prototype) as any;
  itemSystemService.logger = { warn: () => {}, log: () => {}, error: () => {} };
  itemSystemService.staticData = staticData;
  itemSystemService.itemService = itemService;
  itemSystemService.bonusService = new BonusService();
  itemSystemService.playerService = { getMarkerValue: markerReader };

  const service = createGameServiceStub() as any;
  service.staticData = staticData;
  service.itemService = itemService;
  service.itemSystemService = itemSystemService;
  service.combatState = { getAchievementProficiency: markerReader, setJudgment: () => {} };

  return { service, itemSystemService };
}

const equippable = (name: string) => ({ name, type: '装备', quantity: 1, durability: 100, data: 'x' });

describe('装备强化可见性：展示链必须反映强化', () => {
  it('武器 +2：属性按 1.01 倍放大，增量以 (+x.xx) 标注，系数 0.01', () => {
    const { itemSystemService } = makeGameService();
    const r = itemSystemService.formatReinforcedEquipAttrs(equippable('提卡'), { 武器强化: 2 });

    // 系数 = 熟练度 2 / 200 = 0.01
    expect(r.coefficient).toBeCloseTo(0.01, 6);
    expect(r.text).toContain('火伤: 7.94 (+0.08)'); // 7.86 × 1.01 = 7.9386
    expect(r.text).toContain('装甲: 6.79 (+0.07)'); // 6.72 × 1.01 = 6.7872
    expect(r.text).toContain('命中: 3.7 (+0.04)');  // 3.66 × 1.01 = 3.6966
  });

  it('掉落率不被放大（只按 掉落率×a1/5 折成经验）→ 恒定值行不带增量标注', () => {
    const { itemSystemService } = makeGameService();
    const r = itemSystemService.formatReinforcedEquipAttrs(equippable('提卡'), { 武器强化: 2 });
    expect(r.text).toContain('掉落率: 1.11');
    expect(r.text).not.toContain('掉落率: 1.11 (+');
  });

  it('部位装备使用 `${部位}强化` 熟练度：腿部 +100 → 系数 0.5', () => {
    const { itemSystemService } = makeGameService();
    const r = itemSystemService.formatReinforcedEquipAttrs(equippable('加固腿甲'), { 腿部强化: 100 });
    expect(r.coefficient).toBeCloseTo(0.5, 6);
    expect(r.text).toContain('装甲: 10.08 (+3.36)'); // 6.72 × 1.5 = 10.08
  });

  it('未强化：系数 0，属性不带任何增量标注', () => {
    const { itemSystemService } = makeGameService();
    const r = itemSystemService.formatReinforcedEquipAttrs(equippable('加固腿甲'), {});
    expect(r.coefficient).toBe(0);
    expect(r.text).toContain('装甲: 6.72');
    expect(r.text).not.toContain('(+');
  });

  it('增幅器不参与装备强化（即使误配 增幅器强化 / 增幅器等级 标记）', () => {
    const { itemSystemService } = makeGameService();
    const r = itemSystemService.formatReinforcedEquipAttrs(equippable('增幅核心'), {
      增幅器强化: 200,
      增幅器等级: 50,
    });
    expect(r.coefficient).toBe(0);
    expect(r.text).toContain('攻击: 100');
    expect(r.text).not.toContain('(+');
  });

  it('装备栏快照：武器格 enhance/enhanceRate 与强化后 attrs 同步下发', () => {
    const { service } = makeGameService();
    const player = {
      equipment: [],
      weapons: [equippable('提卡')],
      currentWeapon: 1,
    };
    const snap = service.buildEquipmentSnapshot(player, { 武器强化: 2 });
    const weaponCell = snap.find((e: any) => e.slot === '武器');
    expect(weaponCell.enhance).toBe(2);      // 等级 = markers 原值
    expect(weaponCell.enhanceRate).toBe(1);  // 系数百分比 = 0.01 × 100
    expect(weaponCell.attrs).toContain('火伤: 7.94 (+0.08)');
    // 武器详情子列表同口径（前端展开列表 / 悬浮卡共用）
    expect(weaponCell.weapons).toHaveLength(1);
    expect(weaponCell.weapons[0].enhanceRate).toBe(1);
    expect(weaponCell.weapons[0].attrs).toContain('火伤: 7.94 (+0.08)');
  });

  it('查看装备详情：自带块按「装备强化及自带」强化后口径输出（原版 _主程序.ecode L5618）', () => {
    const { itemSystemService } = makeGameService();
    const text = itemSystemService.analyzeEquipmentItem(equippable('提卡'), '装备栏', { 武器强化: 2 });
    expect(text).toContain('装备强化及自带:');
    expect(text).toContain('火伤: 7.94 (+0.08)');
    expect(text).toContain('强化系数: +1%');
    // 强化前口径的旧标头不得再出现（同一件事只允许一套展示口径）
    expect(text).not.toContain('自带属性:');
  });

  it('查看装备详情（未强化）：标头仍是「装备强化及自带」，但不出现系数行与增量标注', () => {
    const { itemSystemService } = makeGameService();
    const text = itemSystemService.analyzeEquipmentItem(equippable('加固腿甲'), '背包', {});
    expect(text).toContain('装备强化及自带:');
    expect(text).toContain('装甲: 6.72');
    expect(text).not.toContain('强化系数');
    expect(text).not.toContain('(+');
  });
});

describe('calcEquipReinforce 是强化系数唯一出口', () => {
  it('系数 = 熟练度/200；逆向熟练度 ≥20 时 ×1.25', () => {
    const bonusService = new BonusService();
    const self: any = { 火伤: 100 };
    const a1 = bonusService.calcEquipReinforce({ type: '武器', name: '提卡', self, bonus: {} }, true, 40, 25, 0);
    expect(a1).toBeCloseTo(0.25, 6);          // 40/200 × 1.25
    expect(self.火伤).toBeCloseTo(125, 6);    // 100 × 1.25
  });

  it('无熟练度时返回 0（不产生任何改动）', () => {
    const bonusService = new BonusService();
    const self: any = { 装甲: 50 };
    expect(bonusService.calcEquipReinforce({ type: '腿部', name: '加固腿甲', self, bonus: {} }, false, 0, 0, 0)).toBe(0);
    expect(self.装甲).toBe(50);
  });
});
