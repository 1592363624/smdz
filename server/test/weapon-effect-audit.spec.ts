/**
 * 装备特效数值「展示 vs 战斗」一致性审计
 *
 * 背景：装备特效（data 串 bx 编号 → effects.json）曾只在展示路径
 * （ItemService.parseEquipment）结算，战斗路径（CombatSystemService.resolveItemBonus /
 * getWeaponData）另起炉灶且不读 effects.json，导致「面板看得到、打架打不出」。
 * 修复后两侧共用 equipment-effect.util 的同一实现，本套件用断言把一致性固化，
 * 任何一侧再次漂移都会失败。
 *
 * 原版口径：物品操作.ecode L1438-1475（解析装备 bx 段）。
 */
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { ItemService } from '../src/modules/game/item.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { StatsService } from '../src/modules/game/stats.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const effects: any[] = require('../prisma/data/effects.json');

const poolOf = (weapon: boolean) =>
  effects.filter((e) => {
    const limit = String(e?.limit ?? '').trim();
    return limit === '' || limit === (weapon ? '武器' : '装备');
  });

const weaponPool = poolOf(true);
const poolIndex = (pool: any[], name: string) => pool.findIndex((e) => e?.name === name) + 1;

/** 首个带 bonus 的武器特效（回归基准） */
const WEAPON_EFFECT_ID = weaponPool.findIndex((e) => e?.bonus && Object.keys(e.bonus).length > 0) + 1;
const WEAPON_EFFECT_ROW = weaponPool[WEAPON_EFFECT_ID - 1];
const WEAPON_EFFECT_KEYS = Object.keys(WEAPON_EFFECT_ROW.bonus);

/** 核装药：攻击冷却10 / aoe / 必中 / 攻击文本 —— 覆盖特效的全部附加语义 */
const NUKE_ID = poolIndex(weaponPool, '核装药');
/** 航空母舰：攻击次数=1，按原版「>=2 才追加」的门槛不应生效 */
const CARRIER_ID = poolIndex(weaponPool, '航空母舰');

const cleanDef = () => ({
  name: '审计用测试枪',
  equipType: '射弹武器',
  specialSeq: -1,
  specialEffect: 0,
  cooldown: 10,
  baseBonus: {},
  bonus: {},
  properties: { damage: { phys: 100, fire: 0, ice: 0, elec: 0 } },
});

const makeStaticData = (shared: any) =>
  ({
    getEquipmentByName: (name: string) => (name === shared.name ? shared : undefined),
    isWeapon: (def: any) => String(def?.equipType ?? '').endsWith('武器'),
    getEffectById: (id: number, weapon: boolean) => poolOf(weapon)[id - 1],
    getAllEffects: () => effects,
  } as unknown as StaticDataService);

const buildCombat = (staticData: StaticDataService) =>
  new CombatSystemService(
    {} as PrismaService,
    { safeJsonParse: (v: string, f: any) => { try { return JSON.parse(v); } catch { return f; } } } as unknown as PlayerService,
    new BonusService(),
    {} as MapService,
    staticData,
    {} as AchievementService,
    {} as any,
    {} as CombatStateService,
    {} as StatsService,
  );

const buildItemService = (staticData: StaticDataService) =>
  new ItemService({} as PrismaService, staticData, {} as CombatStateService, {} as any, {} as MapService);

const bonusService = new BonusService();

describe('装备特效数值：展示路径与战斗路径同源', () => {
  it('前置条件：effects.json 中存在带 bonus 的武器特效', () => {
    expect(WEAPON_EFFECT_ID).toBeGreaterThan(0);
    expect(WEAPON_EFFECT_KEYS.length).toBeGreaterThan(0);
  });

  it('展示路径：parseEquipment 把特效 bonus 并入 baseBonus', () => {
    const shared = cleanDef();
    const item: any = { name: shared.name, type: '装备', data: `a!bx${WEAPON_EFFECT_ID}` };
    const parsed = buildItemService(makeStaticData(shared)).parseEquipment(item);
    for (const key of WEAPON_EFFECT_KEYS) {
      expect(Number(parsed.baseBonus?.[key] ?? 0)).toBeCloseTo(Number(WEAPON_EFFECT_ROW.bonus[key]), 5);
    }
  });

  it('战斗路径：resolveItemBonus 产出同值的 effectBonus', () => {
    const shared = cleanDef();
    const item: any = { name: shared.name, type: '装备', data: `a!bx${WEAPON_EFFECT_ID}` };
    const resolved = (buildCombat(makeStaticData(shared)) as any).resolveItemBonus(item);
    for (const key of WEAPON_EFFECT_KEYS) {
      expect(Number(resolved.effectBonus?.[key] ?? 0)).toBeCloseTo(Number(WEAPON_EFFECT_ROW.bonus[key]), 5);
    }
  });

  it('展示路径不再污染 StaticDataService 缓存（解析多次仍为原始值）', () => {
    const shared = cleanDef();
    const itemService = buildItemService(makeStaticData(shared));
    const item: any = { name: shared.name, type: '装备', data: `a!bx${WEAPON_EFFECT_ID}` };
    itemService.parseEquipment(item);
    itemService.parseEquipment(item);
    expect(shared.baseBonus).toEqual({});
  });

  it('展示与战斗解析出的特效加成逐键一致', () => {
    const shared = cleanDef();
    const staticData = makeStaticData(shared);
    const item: any = { name: shared.name, type: '装备', data: `a!bx${WEAPON_EFFECT_ID}` };
    const parsed = buildItemService(staticData).parseEquipment(item);
    const resolved = (buildCombat(staticData) as any).resolveItemBonus(item);
    for (const key of WEAPON_EFFECT_KEYS) {
      expect(Number(resolved.effectBonus?.[key] ?? 0))
        .toBeCloseTo(Number(parsed.baseBonus?.[key] ?? 0), 5);
    }
  });
});

describe('武器特效附加语义在战斗侧生效', () => {
  it('38 号特效：战斗侧伤害属性同样 ×1.25（与展示一致）', () => {
    const shared = cleanDef();
    const staticData = makeStaticData(shared);
    const item: any = { name: shared.name, type: '装备', data: 'a!bx38' };
    const parsed = buildItemService(staticData).parseEquipment(item);
    const weaponData = (buildCombat(staticData) as any).getWeaponData({ weapons: [item], equipment: [] }, 1);
    expect(parsed.properties.phys).toBeCloseTo(125, 5);
    expect(Number(weaponData.properties.phys)).toBeCloseTo(125, 5);
  });

  it('冷却：特效攻击冷却追加到武器冷却（核装药 +10）', () => {
    const shared = cleanDef();
    const weaponData = (buildCombat(makeStaticData(shared)) as any).getWeaponData(
      { weapons: [{ name: shared.name, data: `a!bx${NUKE_ID}` }], equipment: [] }, 1,
    );
    expect(NUKE_ID).toBeGreaterThan(0);
    expect(Number(weaponData.cooldown)).toBeCloseTo(20, 5); // 静态 10 + 特效 10
  });

  it('攻击文本：特效指定时覆盖（核装药 → 自爆）', () => {
    const shared = cleanDef();
    const weaponData = (buildCombat(makeStaticData(shared)) as any).getWeaponData(
      { weapons: [{ name: shared.name, data: `a!bx${NUKE_ID}` }], equipment: [] }, 1,
    );
    expect(weaponData.attackText).toBe('自爆');
  });

  it('语义标记：aoe/必中 传入攻击链路', () => {
    const shared = cleanDef();
    const weaponData = (buildCombat(makeStaticData(shared)) as any).getWeaponData(
      { weapons: [{ name: shared.name, data: `a!bx${NUKE_ID}` }], equipment: [] }, 1,
    );
    expect(weaponData.effectFlags?.aoe).toBe(true);
    expect(weaponData.effectFlags?.mustHit).toBe(true);
  });

  it('攻击次数：原版门槛 >=2，数值为 1 的特效不追加', () => {
    const shared = cleanDef();
    const resolved = (buildCombat(makeStaticData(shared)) as any).resolveItemBonus(
      { name: shared.name, type: '装备', data: `a!bx${CARRIER_ID}` },
    );
    expect(CARRIER_ID).toBeGreaterThan(0);
    expect(Number(resolved.bonus?.['攻击次数'] ?? 0)).toBe(0);
  });

  it('无特效装备不产生 effectBonus 与语义标记', () => {
    const shared = cleanDef();
    const resolved = (buildCombat(makeStaticData(shared)) as any).resolveItemBonus(
      { name: shared.name, type: '装备', data: 'a!aa30' },
    );
    expect(Object.keys(resolved.effectBonus ?? {}).length).toBe(0);
  });
});

describe('使魔技能增益数值：确实进入 bonus 计算', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('歼灭模式：攻击2 + 30 + 技能等级（加成计算 L256-299）', () => {
    const bonus: any = {};
    bonusService.calculateGameBonus(
      { bonus, buffs: [{ name: '歼灭模式', expireAt: nowSec() + 60 }], skillLevel: 5 },
      nowSec(),
    );
    expect(bonus.攻击2).toBe(35);
  });

  it('冰精灵：冰伤2 + 30 + 技能等级，并追加穿透10', () => {
    const bonus: any = {};
    bonusService.calculateGameBonus(
      { bonus, buffs: [{ name: '冰精灵', expireAt: nowSec() + 60 }], skillLevel: 5 },
      nowSec(),
    );
    expect(bonus.冰伤2).toBe(35);
    expect(bonus.生命穿透).toBe(10);
  });

  it('增益过期后数值不再计入', () => {
    const bonus: any = {};
    bonusService.calculateGameBonus(
      { bonus, buffs: [{ name: '歼灭模式', expireAt: nowSec() - 1 }], skillLevel: 5 },
      nowSec(),
    );
    expect(bonus.攻击2 ?? 0).toBe(0);
  });
});
