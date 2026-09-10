/**
 * 全局熟练度（原版「全局标记」）与怪物动态等级。
 *
 * 复刻依据：
 * - 数据显示.ecode L1640 显示熟练度等级 = 最小 a 使 点数 < a² → floor(√点数)+1
 * - 加成计算.ecode L2711 / L2796 怪物等级 = 物种熟练度等级(去物种前缀) + 世界熟练度等级
 * - 战斗相关.ecode L3667-3688 任意一方被击杀 → 该物种熟练度 +1、世界熟练度 +1
 * - 数据存取.ecode L551-602 怪物节不读取「等级」字段 → 配置等级恒 0 → 恒走动态
 */

import { MapService } from '../src/modules/game/map.service';
import {
  GlobalProficiencyService,
  GLOBAL_MARKERS_KEY,
  WORLD_PROFICIENCY_NAME,
  pickMonsterLevel,
  proficiencyLevelFromPoints,
} from '../src/modules/game/global-proficiency.service';
import { stripSpeciesPrefix } from '../src/modules/game/species-prefix.util';
import { HandbookService } from '../src/modules/game/handbook.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

function makeSystemConfigStub(initial: Array<{ key: string; value: string; type?: string }> = []) {
  const rows = new Map<string, any>();
  for (const [idx, row] of initial.entries()) {
    rows.set(row.key, { id: idx + 1, type: 'json', ...row });
  }
  const prisma: any = {
    rows,
    systemConfig: {
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.key) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.key);
        Object.assign(row, data);
        return row;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: rows.size + 1, ...data };
        rows.set(data.key, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows.delete(where.key);
        return {};
      }),
    },
  };
  return prisma;
}

describe('显示熟练度等级换算（原版 数据显示.ecode L1640）', () => {
  it('floor(√点数)+1：点数 0 也返回 1 级', () => {
    expect(proficiencyLevelFromPoints(0)).toBe(1);
    expect(proficiencyLevelFromPoints(1)).toBe(2);
    expect(proficiencyLevelFromPoints(3)).toBe(2);
    expect(proficiencyLevelFromPoints(4)).toBe(3);
    expect(proficiencyLevelFromPoints(8)).toBe(3);
    expect(proficiencyLevelFromPoints(9)).toBe(4);
    expect(proficiencyLevelFromPoints(15)).toBe(4);
    expect(proficiencyLevelFromPoints(16)).toBe(5);
  });

  it('负数/NaN 按 0 处理（等价原版无该标记）', () => {
    expect(proficiencyLevelFromPoints(-5)).toBe(1);
    expect(proficiencyLevelFromPoints(Number.NaN)).toBe(1);
  });
});

describe('物种前缀归一化（原版 精英前缀替换=精英 神兽 深蓝 巨型）', () => {
  it('剔除精英/神兽/深蓝/巨型与分身', () => {
    expect(stripSpeciesPrefix('精英史莱姆')).toBe('史莱姆');
    expect(stripSpeciesPrefix('神兽白虎')).toBe('白虎');
    expect(stripSpeciesPrefix('深蓝心之守望')).toBe('心之守望');
    expect(stripSpeciesPrefix('巨型宇航兔')).toBe('宇航兔');
    expect(stripSpeciesPrefix('白分身')).toBe('白');
    expect(stripSpeciesPrefix('史莱姆')).toBe('史莱姆');
  });
});

describe('GlobalProficiencyService', () => {
  it('空表基线：世界等级 1，怪物等级 = 物种1 + 世界1 = 2', async () => {
    const service = new GlobalProficiencyService(makeSystemConfigStub());
    await service.ensureLoaded();
    expect(await service.worldLevel()).toBe(1);
    expect(await service.monsterLevel('史莱姆')).toBe(2);
  });

  it('累积后按公式抬升等级，并把增量落盘为 json 配置行', async () => {
    const prisma = makeSystemConfigStub();
    const service = new GlobalProficiencyService(prisma);
    // 世界熟练度 9 点 → 世界等级 4；史莱姆 4 点 → 物种等级 3
    await service.addProficiency(WORLD_PROFICIENCY_NAME, 9);
    await service.addProficiency('史莱姆', 4);
    expect(await service.worldLevel()).toBe(4);
    expect(await service.monsterLevel('史莱姆')).toBe(3 + 4);

    await service.flush();
    const row = prisma.rows.get(GLOBAL_MARKERS_KEY);
    expect(row).toBeDefined();
    expect(row.type).toBe('json');
    expect(JSON.parse(row.value)).toEqual({ 世界熟练度: 9, 史莱姆熟练度: 4 });
  });

  it('精英怪与普通怪共用同一份熟练度（读取侧去前缀的意图）', async () => {
    const service = new GlobalProficiencyService(makeSystemConfigStub());
    await service.addProficiency('精英史莱姆', 4);
    // 写入侧按基名归一 → 史莱姆熟练度=4 → 物种等级 3
    expect(await service.getPoints('史莱姆')).toBe(4);
    expect(await service.monsterLevel('史莱姆')).toBe(3 + 1);
    expect(await service.monsterLevel('精英史莱姆')).toBe(3 + 1);
  });

  it('已有配置行时从 json 加载体现在等级上', async () => {
    const prisma = makeSystemConfigStub([
      { key: GLOBAL_MARKERS_KEY, value: JSON.stringify({ 世界熟练度: 16, 史莱姆熟练度: 9 }) },
    ]);
    const service = new GlobalProficiencyService(prisma);
    expect(await service.worldLevel()).toBe(5);
    expect(await service.monsterLevel('史莱姆')).toBe(4 + 5);
  });

  it('旧配置 game.worldLevel 迁移为世界熟练度并删除旧键（单一真相源）', async () => {
    const prisma = makeSystemConfigStub([{ key: 'game.worldLevel', value: '4', type: 'number' }]);
    const service = new GlobalProficiencyService(prisma);
    expect(await service.worldLevel()).toBe(4);
    expect(prisma.rows.has('game.worldLevel')).toBe(false);
    expect(prisma.rows.get(GLOBAL_MARKERS_KEY).value).toBe(JSON.stringify({ 世界熟练度: 9 }));
  });

  it('setWorldLevel 用逆运算 (等级-1)² 写回点数', async () => {
    const service = new GlobalProficiencyService(makeSystemConfigStub());
    await service.setWorldLevel(5);
    expect(await service.worldLevel()).toBe(5);
    expect(await service.getPoints(WORLD_PROFICIENCY_NAME)).toBe(16);
  });

  it('点数为 0 的条目不入表（等价原版条目被移除）', async () => {
    const service = new GlobalProficiencyService(makeSystemConfigStub());
    await service.addProficiency('史莱姆', 3);
    await service.addProficiency('史莱姆', -3);
    expect(await service.getPoints('史莱姆')).toBe(0);
    expect(await service.snapshot()).toEqual({});
  });
});

describe('MapService 怪物等级解析（原版 加成计算 L2709-2716 / L2793-2807）', () => {
  function makeMapServiceFixture(monsterDefs: any[], proficiency: GlobalProficiencyService) {
    const created: any[] = [];
    const prisma: any = {
      gameMap: { findUnique: jest.fn(async () => ({ id: 7, name: '测试地图' })) },
      gameMonster: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async ({ data }: any) => {
          created.push(...data);
          return { count: data.length };
        }),
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    };
    const staticData: any = {
      getMapByName: jest.fn(() => null),
      getAllMonsters: jest.fn(() => monsterDefs),
      getAllBuffs: jest.fn(() => []),
    };
    // buildMonsterBonusFromDef 会调用若干加成/套装子过程；本用例只关心等级，
    // 故统一桩成空实现（无增益、无套装、战斗力 0）。
    const bonusService: any = {
      calcCombatPower: jest.fn(() => 0),
      calculateBuffs: jest.fn(),
      calculateTreasureBonus: jest.fn(),
      calculateHanGuangBonus: jest.fn(),
      consumeReverseFairytaleBuffs: jest.fn(),
    };
    const combatState: any = { setJudgment: jest.fn() };
    const service = new MapService(
      prisma,
      staticData,
      bonusService,
      combatState,
      { emit: jest.fn() } as any,
      undefined,
      proficiency,
    );
    return { service, created };
  }

  const slimeDef = {
    name: '史莱姆',
    type: '怪物',
    level: 0,
    hp: 30,
    shield: 0,
    armor: 0,
    dodge: 10,
    hit: 10,
    speed: 100,
    attack: 10,
    bonus: {},
  };

  it('配置等级为 0 → 走动态公式（熟练度累积后刷出的怪变强）', async () => {
    const proficiency = new GlobalProficiencyService(makeSystemConfigStub());
    const { service, created } = makeMapServiceFixture([slimeDef], proficiency);
    jest.spyOn(service, 'getMapById').mockResolvedValue({
      id: 7, name: '测试地图', monsters: ['史莱姆'], monsterCount: 1, level: 1,
    } as any);

    await service.refreshMapMonsters(7);
    expect(created[0].level).toBe(2); // 物种1 + 世界1

    // 击杀累积：史莱姆 +4（物种等级 3）、世界 +9（世界等级 4）→ 重刷后 7 级
    await proficiency.addProficiency('史莱姆', 4);
    await proficiency.addProficiency(WORLD_PROFICIENCY_NAME, 9);
    created.length = 0;
    await service.refreshMapMonsters(7);
    expect(created[0].level).toBe(7);
    // 等级确实进入成长公式：生命 = (1+等级*0.05)*(30+等级*20)
    expect(created[0].hp).toBe(Math.floor(1.35 * (30 + 140)));
  });

  it('配置等级 > 0 → 直接用配置等级（原版 L2710 短路分支）', async () => {
    const proficiency = new GlobalProficiencyService(makeSystemConfigStub());
    const { service, created } = makeMapServiceFixture(
      [{ ...slimeDef, level: 5 }],
      proficiency,
    );
    jest.spyOn(service, 'getMapById').mockResolvedValue({
      id: 7, name: '测试地图', monsters: ['史莱姆'], monsterCount: 1, level: 1,
    } as any);

    await service.refreshMapMonsters(7);
    expect(created[0].level).toBe(5);
  });

  it('显式等级（召唤物 强制等级）优先于动态公式', async () => {
    const proficiency = new GlobalProficiencyService(makeSystemConfigStub());
    const { service } = makeMapServiceFixture([slimeDef], proficiency);
    jest.spyOn(service, 'getMapById').mockResolvedValue({
      id: 7, name: '测试地图', monsters: ['史莱姆'], monsterCount: 1, level: 1,
    } as any);

    const row: any = await service.spawnMonsterByName(7, '史莱姆', { level: 9, isTemp: true });
    expect(row.level).toBe(9);
  });

  it('未注入全局熟练度（测试桩）时等级退化为基线 1，不抛错', async () => {
    const { service, created } = makeMapServiceFixture([slimeDef], undefined as any);
    jest.spyOn(service, 'getMapById').mockResolvedValue({
      id: 7, name: '测试地图', monsters: ['史莱姆'], monsterCount: 1, level: 1,
    } as any);

    await service.refreshMapMonsters(7);
    expect(created[0].level).toBe(1);
  });
});

describe('pickMonsterLevel 等级优先规则（原版 L2709-2716 / L2793-2807）', () => {
  it('显式等级 > 配置等级 > 动态等级', () => {
    expect(pickMonsterLevel({ explicitLevel: 9, configuredLevel: 5, dynamicLevel: 2 })).toBe(9);
    expect(pickMonsterLevel({ explicitLevel: 0, configuredLevel: 5, dynamicLevel: 2 })).toBe(5);
    expect(pickMonsterLevel({ configuredLevel: 0, dynamicLevel: 7 })).toBe(7);
    expect(pickMonsterLevel({ dynamicLevel: 2 })).toBe(2);
  });

  it('非法/非正值不参与短路', () => {
    expect(pickMonsterLevel({ explicitLevel: Number.NaN, configuredLevel: -3, dynamicLevel: 4 })).toBe(4);
  });
});

describe('图鉴怪物等级展示（原版 数据显示 L3165-3166 / L3171）', () => {
  const staticData = new StaticDataService();
  function makeHandbook(proficiency?: GlobalProficiencyService) {
    return new HandbookService(staticData, {} as any, proficiency);
  }

  it('基础等级 = 物种熟练度等级，并带「(点数/下一档需求)」后缀', async () => {
    const proficiency = new GlobalProficiencyService(makeSystemConfigStub());
    const handbook = makeHandbook(proficiency);

    expect(await handbook.handle('史莱姆', { userId: 1, playerName: '路人甲' })).toContain('基础等级:1（0/1）');

    // 4 点 → 物种等级 3，下一档需求 9
    await proficiency.addProficiency('史莱姆', 4);
    expect(await handbook.handle('史莱姆', { userId: 1, playerName: '路人甲' })).toContain('基础等级:3（4/9）');
  });

  it('详细数据的等级 = 会真正刷出的动态等级（物种 + 世界）', async () => {
    const proficiency = new GlobalProficiencyService(makeSystemConfigStub());
    await proficiency.addProficiency('史莱姆', 4);          // 物种 3
    await proficiency.addProficiency(WORLD_PROFICIENCY_NAME, 9); // 世界 4
    const handbook = makeHandbook(proficiency);

    const out = await handbook.handle('史莱姆详细', { userId: 1, playerName: '路人甲' });
    expect(out).toContain('等级:7');
  });

  it('未注入熟练度服务时不抛错，基础等级按 1 兜底', async () => {
    const handbook = makeHandbook();
    expect(await handbook.handle('史莱姆', { userId: 1, playerName: '路人甲' })).toContain('基础等级:1');
  });
});
