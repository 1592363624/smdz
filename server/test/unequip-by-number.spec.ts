/**
 * 「卸下 N」编号卸下（2026-09-09）
 *
 * 口径单源：itemService.buildEquippedList(player) 按「信息」面板装备栏行序
 * （12 部位 → 手持武器 → 植入 → 增幅 → 背上备用武器）返回已装备项，序号 = index+1。
 * unequipItem 纯数字分支按该序号精确定位（武器按 weapons[] 索引 splice，
 * 同名武器不再受「按名字只命中第一把」限制）；三处消费方（面板渲染/快照/卸下）禁各自重算。
 */
import { ItemService } from '../src/modules/game/item.service';

const SLOT_MAP: Record<string, string> = {
  动力头盔: '头部',
  布衣: '上身',
  植入体: '植入体',
  增幅器: '增幅器',
};

function makeService(player: any) {
  const service = Object.create(ItemService.prototype) as any;
  service.logger = { warn: () => {}, log: () => {}, error: () => {} };
  service.staticData = {
    getEquipmentByName: (name: string) => {
      const slot = SLOT_MAP[name];
      if (slot === '植入体') return { equipType: '植入体', specialSeq: 1 };
      if (slot === '增幅器') return { equipType: '增幅器', specialSeq: 1 };
      if (slot) return { equipType: slot, specialSeq: 1 };
      // 其余名字（武器）按武器定义处理
      return { equipType: '武器', specialSeq: -3, cooldown: 5 };
    },
  };
  service.combatState = { setJudgment: () => {} };
  service.playerService = {
    getPlayerData: async () => ({ player }),
    enqueueUserWrite: async (_uid: number, fn: () => Promise<any>) => fn(),
    savePlayer: async () => {},
  };
  return service;
}

const weapon = (data: string) => ({ name: '纵横', type: '装备', quantity: 1, durability: 100, data });

describe('buildEquippedList 序号口径', () => {
  it('按面板行序排列：12 部位 → 手持武器 → 植入 → 增幅 → 背上，序号 1-based 连续', () => {
    const player = {
      equipment: [
        { name: '植入体', type: '装备', data: 'e' },
        { name: '布衣', type: '装备', data: 'c' },
        { name: '动力头盔', type: '装备', data: 'b' },
      ],
      weapons: [weapon('s'), weapon('c'), weapon('a')],
      currentWeapon: 2, // 手持第二把
    };
    const list = makeService(player).buildEquippedList(player);

    expect(list.map((e) => `${e.no}.${e.slot}`)).toEqual([
      '1.头部', // 12 部位顺序：头部在最先
      '2.上身',
      '3.武器', // 手持 = weapons[1]
      '4.植入',
      '5.背上', // weapons[0]
      '6.背上', // weapons[2]
    ]);
    expect(list[2].weaponIndex).toBe(1);
    expect(list[4].weaponIndex).toBe(0);
    expect(list[5].weaponIndex).toBe(2);
  });

  it('空槽位不入列不占号；空手时无武器项', () => {
    const player = {
      equipment: [{ name: '布衣', type: '装备', data: 'c' }],
      weapons: [],
      currentWeapon: 0,
    };
    const list = makeService(player).buildEquippedList(player);
    expect(list).toHaveLength(1);
    expect(list[0].slot).toBe('上身');
    expect(list[0].no).toBe(1);
  });
});

describe('unequipItem 编号分支（卸下 N）', () => {
  it('「卸下 1」卸第一件部位装备：equipment 移除、backpack 回填、文案带序号与品质', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [],
      equipment: [
        { name: '动力头盔', type: '装备', data: 'b' },
        { name: '布衣', type: '装备', data: 'c' },
      ],
      weapons: [],
      currentWeapon: 0,
    };
    const result = await makeService(player).unequipItem(42, '1');

    expect(player.equipment).toHaveLength(1);
    expect(player.equipment[0].name).toBe('布衣');
    expect(player.backpack).toHaveLength(1);
    expect(player.backpack[0].name).toBe('动力头盔');
    expect(result).toContain('卸下了编号1的动力头盔');
    expect(result).toContain('[精良]'); // data 'b' → 精良
    expect(result).toContain('头部');
  });

  it('编号越界 → 提示已装备总数并引导发「信息」', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [],
      equipment: [{ name: '布衣', type: '装备', data: 'c' }],
      weapons: [],
      currentWeapon: 0,
    };
    const result = await makeService(player).unequipItem(42, '5');

    expect(player.equipment).toHaveLength(1);
    expect(player.backpack).toHaveLength(0);
    expect(result).toContain('未找到编号5');
    expect(result).toContain('已装备 1 件');
  });

  it('背上两把同名武器，卸第二把的编号 → 按 weapons[] 索引精确移除（按名字只会命中第一把）', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [],
      equipment: [],
      weapons: [weapon('s·绝对零度'), weapon('c')],
      currentWeapon: 0, // 空手，两把都在背上
    };
    // 序号：两把背上武器分别是 1 和 2
    const result = await makeService(player).unequipItem(42, '2');

    expect(player.weapons).toHaveLength(1);
    expect(player.weapons[0].data).toBe('s·绝对零度'); // 留下的是第一把
    expect(player.backpack).toHaveLength(1);
    expect(player.backpack[0].data).toBe('c'); // 卸下的是第二把
    expect(result).toContain('卸下了编号2的纵横');
  });

  it('卸下手持武器（编号）→ currentWeapon 收敛不越界', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [],
      equipment: [],
      weapons: [weapon('s'), weapon('c')],
      currentWeapon: 2, // 手持第二把 → 已装备序号 1=武器
    };
    await makeService(player).unequipItem(42, '1');

    expect(player.weapons).toHaveLength(1);
    expect(player.weapons[0].data).toBe('s');
    // 卸后 length=1，原 currentWeapon=2 > 1 → 收敛到 1（保持既有"手上那把不变"口径的收敛规则）
    expect(player.currentWeapon).toBe(1);
  });

  it('植入体编号 → 拦截提示，装备不动', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [],
      equipment: [{ name: '植入体', type: '装备', data: 'e' }],
      weapons: [],
      currentWeapon: 0,
    };
    const result = await makeService(player).unequipItem(42, '1');

    expect(result).toContain('植入体无法被卸下');
    expect(player.equipment).toHaveLength(1);
    expect(player.backpack).toHaveLength(0);
  });

  it('非数字参数仍走名称匹配（原行为回归）', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [],
      equipment: [{ name: '布衣', type: '装备', data: 'c' }],
      weapons: [],
      currentWeapon: 0,
    };
    const result = await makeService(player).unequipItem(42, '布衣');

    expect(player.equipment).toHaveLength(0);
    expect(player.backpack).toHaveLength(1);
    expect(result).toContain('卸下了布衣');
  });
});
