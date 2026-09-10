/**
 * 装备引用解析 + 按品质锁定/解锁 回归测试（2026-09-10）
 *
 * 背景：玩家眼中的装备名是「基础名 + 品质码 + 可选·特效」（背包显示 冰雹S / 冰雹S·纯洁无瑕），
 * 而背包条目 item.name 只存基础名（冰雹），品质码在 item.data 首字符（s）。
 * 此前只有「装备」指令内联支持品质码，锁定/解锁只做整名精确匹配，
 * 导致「锁定装备冰雹S」永远提示"背包中没有【冰雹S】装备"。
 *
 * 本测试锁定口径：解析与匹配必须是单一实现（equipment-ref.util），
 * 且带品质码时不得降级到任意品质（2026-09-06 品质错配事故的护栏）。
 */
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { ItemService, Item3 } from '../src/modules/game/item.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import {
  parseEquipmentRef,
  resolveEquipmentRefIndex,
  resolveEquipmentRefIndexes,
  findEquipmentIndexByInstance,
  describeQualityMiss,
} from '../src/modules/game/equipment-ref.util';

const itemServiceReal = new ItemService(
  {} as PrismaService,
  {} as StaticDataService,
  {} as any,
  {} as any,
  {} as any,
);
const itemSystem = new ItemSystemService(
  {} as PrismaService,
  {} as PlayerService,
  {} as BonusService,
  itemServiceReal,
  {} as AchievementService,
  new StaticDataService(),
);

const mk = (name: string, data: string, durability = 0): Item3 =>
  ({ name, type: '装备', quantity: 1, durability, data } as Item3);

describe('parseEquipmentRef：玩家输入形态解析', () => {
  it('基础名 + 单字母品质码（冰雹S / 冰雹s）', () => {
    expect(parseEquipmentRef('冰雹S').candidates[0]).toEqual({ baseName: '冰雹', quality: 's' });
    expect(parseEquipmentRef('冰雹s').candidates[0]).toEqual({ baseName: '冰雹', quality: 's' });
  });

  it('基础名 + 品质码 + ·特效（冰雹S·纯洁无瑕）', () => {
    const ref = parseEquipmentRef('冰雹S·纯洁无瑕');
    expect(ref.core).toBe('冰雹S');
    expect(ref.candidates[0]).toEqual({ baseName: '冰雹', quality: 's' });
  });

  it('基础名 + 中文品质词（冰雹传说）与中括号品质（冰雹[传说]）', () => {
    expect(parseEquipmentRef('冰雹传说').candidates).toContainEqual({ baseName: '冰雹', quality: 's' });
    expect(parseEquipmentRef('冰雹[传说]').candidates[0]).toEqual({ baseName: '冰雹', quality: 's' });
    expect(parseEquipmentRef('冰雹[S]').candidates[0]).toEqual({ baseName: '冰雹', quality: 's' });
  });

  it('纯基础名无误判：冰雹 / 传说 不产生品质候选', () => {
    expect(parseEquipmentRef('冰雹').candidates).toHaveLength(0);
    // 整串就是品质词时不得解析出空基础名（否则会误伤「锁定装备传说」批量分支之外的路径）
    expect(parseEquipmentRef('传说').candidates).toHaveLength(0);
  });
});

describe('resolveEquipmentRefIndexes：背包定位口径', () => {
  const backpack = [mk('布帽', 'e'), mk('冰雹', 'a'), mk('冰雹', 's'), mk('冰雹', 's')];

  it('带品质码只命中该品质（不降级到任意品质）', () => {
    expect(resolveEquipmentRefIndexes(backpack, '冰雹S')).toEqual([2, 3]);
    expect(resolveEquipmentRefIndexes(backpack, '冰雹A')).toEqual([1]);
  });

  it('带品质码但无对应品质 → 空，绝不降级', () => {
    expect(resolveEquipmentRefIndexes(backpack, '冰雹X')).toEqual([]);
    expect(resolveEquipmentRefIndex(backpack, '冰雹X')).toBe(-1);
  });

  it('不带品质码 → 命中全部同名（原版批量语义）', () => {
    expect(resolveEquipmentRefIndexes(backpack, '冰雹')).toEqual([1, 2, 3]);
  });

  it('仅带·特效后缀 → 命中全部同名', () => {
    expect(resolveEquipmentRefIndexes(backpack, '冰雹·纯洁无瑕')).toEqual([1, 2, 3]);
  });

  it('非装备条目不参与装备定位', () => {
    const mixed: any[] = [
      { name: '冰雹', type: '资源', quantity: 3, durability: 0, data: '' },
      mk('冰雹', 's'),
    ];
    expect(resolveEquipmentRefIndexes(mixed, '冰雹S')).toEqual([1]);
  });

  it('显示全名回退（formatEquipmentInventoryDisplay 口径）', () => {
    const withDisplay = [mk('矢量', 'b')];
    expect(
      resolveEquipmentRefIndex(withDisplay, '矢量B·绝对零度', {
        displayName: () => '矢量B·绝对零度',
      }),
    ).toBe(0);
  });
});

describe('按品质锁定/解锁（锁定装备 冰雹S）', () => {
  it('只锁指定品质，同名的其他品质不受影响', () => {
    const backpack = [mk('冰雹', 'a'), mk('冰雹', 's'), mk('冰雹', 's'), mk('布帽', 'e')];
    const touched = (itemSystem as any)['setLockByName'](backpack, '冰雹S', true);
    expect(touched).toHaveLength(2);
    expect(backpack[0].durability).toBe(0);
    expect(backpack[1].durability).toBe(1);
    expect(backpack[2].durability).toBe(1);
    expect(backpack[3].durability).toBe(0);
  });

  it('解锁同口径：只解指定品质', () => {
    const backpack = [mk('冰雹', 'a', 1), mk('冰雹', 's', 1)];
    const touched = (itemSystem as any)['setLockByName'](backpack, '冰雹S', false);
    expect(touched).toHaveLength(1);
    expect(backpack[0].durability).toBe(1);
    expect(backpack[1].durability).toBe(0);
  });

  it('无品质码输入维持原批量语义（全部同名）', () => {
    const backpack = [mk('信号枪', 'b'), mk('信号枪', 'a'), mk('布帽', 'c')];
    const touched = (itemSystem as any)['setLockByName'](backpack, '信号枪', true);
    expect(touched).toHaveLength(2);
  });

  it('品质不符时给出可诊断的提示信息', () => {
    const backpack = [mk('冰雹', 'a')];
    expect(describeQualityMiss(backpack, '冰雹S')).toEqual({ baseName: '冰雹', qualityName: '传说' });
    expect(describeQualityMiss(backpack, '不存在的装备S')).toBeNull();
  });
});

describe('分解 / 解析 指令接入统一解析（2026-09-10）', () => {
  /** 轻量静态数据桩：不触发文件加载，装备定义查询一律返回 undefined。 */
  const staticDataStub: any = {
    getAllCraftings: () => [],
    getEquipmentByName: () => undefined,
    getItemByName: () => undefined,
    isWeapon: () => false,
    getAllEffects: () => [],
  };

  const buildSystem = (backpack: any[], player: any = { name: '测试' }) => {
    const playerService: any = {
      getPlayerData: async () => ({ player, backpack, markers: {}, equipment: [], weapons: [], safeBox: [] }),
      enqueueUserWrite: async (_u: number, fn: () => Promise<void>) => fn(),
      savePlayer: async () => {},
    };
    const achievementStub: any = { setAchievement: () => {} };
    return new ItemSystemService(
      {} as PrismaService,
      playerService,
      {} as BonusService,
      itemServiceReal,
      achievementStub,
      staticDataStub,
    );
  };

  it('分解 冰雹S 只分解该品质，同名其他品质原样保留', async () => {
    const backpack = [mk('冰雹', 'a'), mk('冰雹', 's')];
    const system = buildSystem(backpack);
    const message = await system.deconstructItem(1, '冰雹S');
    expect(message).toContain('分解了冰雹');
    expect(backpack.some((item) => item.name === '冰雹' && item.data === 'a')).toBe(true);
    expect(backpack.some((item) => item.name === '冰雹' && item.data === 's')).toBe(false);
  });

  it('分解 冰雹X（无该品质）→ 报品质不符，背包不变', async () => {
    const backpack = [mk('冰雹', 'a'), mk('冰雹', 's')];
    const system = buildSystem(backpack);
    const message = await system.deconstructItem(1, '冰雹X');
    expect(message).toContain('神迹品质');
    expect(backpack).toHaveLength(2);
  });

  it('解析 冰雹S 命中 S 那件（而非背包里第一件同名装备）', async () => {
    const backpack = [mk('冰雹', 'a'), mk('冰雹', 's')];
    const system = buildSystem(backpack);
    const message = await system.analyzeEquipment(1, '冰雹S');
    expect(message).toContain('传说');
    expect(message).not.toContain('未找到');
  });
});

describe('按装备实例还原（装备预设加载）', () => {
  const backpack = [mk('冰雹', 'a'), mk('冰雹', 's')];

  it('基础名 + 品质码双匹配，不再张冠李戴', () => {
    expect(findEquipmentIndexByInstance(backpack, { name: '冰雹', data: 's' })).toBe(1);
    expect(findEquipmentIndexByInstance(backpack, { name: '冰雹', data: 'a' })).toBe(0);
  });

  it('实例无品质码 → 退化为仅基础名（兼容历史预设数据）', () => {
    expect(findEquipmentIndexByInstance(backpack, { name: '冰雹' })).toBe(0);
  });

  it('品质在背包中不存在 → 兜底回基础名，不让预设静默丢装备', () => {
    expect(findEquipmentIndexByInstance(backpack, { name: '冰雹', data: 'x' })).toBe(0);
  });
});

describe('保护 / 丢弃 也走统一解析（2026-09-10）', () => {
  const staticDataStub: any = {
    getAllCraftings: () => [],
    getEquipmentByName: () => undefined,
    getItemByName: () => undefined,
    isWeapon: () => false,
    getAllEffects: () => [],
  };

  const buildSystem = (backpack: any[], safeBox: any[] = [], player: any = { name: '测试' }) => {
    const playerService: any = {
      getPlayerData: async () => ({ player, backpack, markers: {}, equipment: [], weapons: [], safeBox }),
      enqueueUserWrite: async (_u: number, fn: () => Promise<void>) => fn(),
      savePlayer: async () => {},
    };
    return new ItemSystemService(
      {} as PrismaService,
      playerService,
      {} as BonusService,
      itemServiceReal,
      { setAchievement: () => {} } as any,
      staticDataStub,
    );
  };

  it('保护 冰雹S 只把 S 件收进保险柜', async () => {
    const backpack = [mk('冰雹', 'a'), mk('冰雹', 's')];
    const safeBox: any[] = [];
    const system = buildSystem(backpack, safeBox);
    const message = await system.protectItem(1, '冰雹S');
    expect(message).toContain('保护到了保险柜');
    expect(safeBox.map((item) => item.data)).toEqual(['s']);
    expect(backpack.map((item) => item.data)).toEqual(['a']);
  });

  it('丢弃 冰雹S 只丢 S 件', async () => {
    const backpack = [mk('冰雹', 'a'), mk('冰雹', 's')];
    const system = buildSystem(backpack);
    const message = await system.discardItem(1, '冰雹S');
    expect(message).toContain('丢弃了冰雹');
    expect(backpack.map((item) => item.data)).toEqual(['a']);
  });
});
