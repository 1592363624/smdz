/**
 * 同名武器唯一化（2026-09-09 设计变更）
 *
 * 背景：原版允许背上多把同名武器，但按名字切换只命中第一把、且攻击冷却按「武器名」
 * 写 markers2 同名共用——多把同名武器没有战术价值，只有背包噪音与认知负担。
 *
 * 新口径：equipItem 装备武器时，若背上已有同名（基础名相同、品质码可以不同）武器，
 * 直接顶替背上那把的位置，旧武器放回背包，并在文案中点明哪件被替换（带品质中括号区分）。
 *
 * 索引稳定性：顶替原位置而非追加尾部，weapons 长度不变，currentWeapon 的 1-based
 * 索引语义稳定——手里拿的正是被替换武器时，手持自动延续为新武器；拿别的武器时不受影响。
 */
import { ItemService } from '../src/modules/game/item.service';

function makeService(player: any) {
  const service = Object.create(ItemService.prototype) as any;
  service.logger = { warn: () => {}, log: () => {}, error: () => {} };
  service.staticData = {
    // 纵横/矢量 → 武器（specialSeq<0 命中 isWeapon）；其它名字 → 防具
    getEquipmentByName: (name: string) =>
      name === '纵横' || name === '矢量'
        ? { equipType: '武器', specialSeq: -3, cooldown: 5 }
        : { equipType: '防具', specialSeq: 1 },
  };
  service.combatState = { setJudgment: () => {} };
  service.playerService = {
    getPlayerData: async () => ({ player }),
    enqueueUserWrite: async (_uid: number, fn: () => Promise<any>) => fn(),
    savePlayer: async () => {},
  };
  return service;
}

/** 现实物品形态：name 存基础名，品质码在 data 首字符（复刻生产 schema） */
const weapon = (data: string) => ({ name: '纵横', type: '装备', quantity: 1, durability: 100, data });

describe('equipItem 同名武器唯一化', () => {
  it('背上无同名 + 空手 → 追加尾部并自动拿起（原行为不变）', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [weapon('s·绝对零度')],
      weapons: [],
      equipment: [],
      currentWeapon: 0,
    };
    const result = await makeService(player).equipItem(42, 1);

    expect(player.weapons).toHaveLength(1);
    expect(player.weapons[0].data).toBe('s·绝对零度');
    expect(player.currentWeapon).toBe(1);
    expect(player.backpack).toHaveLength(0);
    expect(result).toContain('拿在手中');
  });

  it('背上无同名 + 已持其它武器 → 追加尾部但不切换（原行为不变）', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [weapon('s·绝对零度')],
      weapons: [{ name: '矢量', type: '装备', quantity: 1, durability: 100, data: 'c' }],
      equipment: [],
      currentWeapon: 1,
    };
    await makeService(player).equipItem(42, 1);

    expect(player.weapons).toHaveLength(2);
    expect(player.currentWeapon).toBe(1);
  });

  it('背上有同名（不同品质）+ 空手 → 顶替位置、旧件下背包、自动拿起新武器并提示替换', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [weapon('c')], // 背包里是 优秀 纵横
      weapons: [weapon('s·绝对零度')], // 背上是 传说 纵横
      equipment: [],
      currentWeapon: 0,
    };
    const result = await makeService(player).equipItem(42, 1);

    // 顶替原位置（仍是 1 把），旧件回到背包
    expect(player.weapons).toHaveLength(1);
    expect(player.weapons[0].data).toBe('c');
    expect(player.backpack).toHaveLength(1);
    expect(player.backpack[0].data).toBe('s·绝对零度');
    // 空手装备 → 自动拿起新武器（位置顶替后即 dupIndex+1）
    expect(player.currentWeapon).toBe(1);
    // 文案点明替换：旧件品质（传说）放回背包、新件拿在手中
    expect(result).toContain('放回了背包');
    expect(result).toContain('拿在了手中');
    expect(result).toContain('纵横[传说]');
    expect(result).toContain('纵横[优秀]');
  });

  it('手里拿的正是被替换的同名武器 → 手持自动延续为新武器，文案点明', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [weapon('c')],
      weapons: [weapon('s·绝对零度')],
      equipment: [],
      currentWeapon: 1, // 手持的就是背上那把同名纵横
    };
    const result = await makeService(player).equipItem(42, 1);

    expect(player.weapons).toHaveLength(1);
    expect(player.weapons[0].data).toBe('c');
    expect(player.currentWeapon).toBe(1); // 索引不变，位置上已是新武器
    expect(player.backpack[0].data).toBe('s·绝对零度');
    expect(result).toContain('放回了背包');
    expect(result).toContain('手中换上了');
    expect(result).toContain('纵横[优秀]');
  });

  it('手持另一把武器 + 背上有同名 → 背上顶替，currentWeapon 与手持武器不受影响', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [weapon('c')],
      weapons: [
        { name: '矢量', type: '装备', quantity: 1, durability: 100, data: 'd' },
        weapon('s·绝对零度'),
      ],
      equipment: [],
      currentWeapon: 1, // 手持矢量
    };
    const result = await makeService(player).equipItem(42, 1);

    expect(player.weapons).toHaveLength(2);
    expect(player.weapons[0].name).toBe('矢量'); // 手持武器位置不动
    expect(player.weapons[1].data).toBe('c'); // 同名顶替
    expect(player.currentWeapon).toBe(1);
    expect(player.backpack[0].data).toBe('s·绝对零度');
    expect(result).toContain('放回了背包');
    expect(result).toContain('背到了背上');
  });

  it('非武器装备走同槽位替换路径，不受本次改动影响', async () => {
    const player: any = {
      name: '伊卡洛斯',
      backpack: [{ name: '动力头盔', type: '装备', quantity: 1, durability: 100, data: 'c' }],
      weapons: [],
      equipment: [{ name: '动力头盔', type: '装备', quantity: 1, durability: 50, data: 'd' }],
      currentWeapon: 0,
    };
    const result = await makeService(player).equipItem(42, 1);

    expect(player.equipment).toHaveLength(1);
    expect(player.equipment[0].data).toBe('c');
    expect(player.backpack).toHaveLength(1);
    expect(player.backpack[0].data).toBe('d');
    expect(result).toContain('脱下');
    expect(result).toContain('换上了');
  });
});
