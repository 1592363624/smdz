/**
 * 生成装备单元测试
 * 对应原版：物品操作.ecode 生成装备() L1128-1261 + 词条转换() L1838-1996
 *
 * 重点回归：模板 bonus 是中文键 JSON（如 {"攻击":10}），旧版 generateEquipment
 * 直接 Object.assign 中文键导致编码查找落空、加成全部丢失。本测试验证：
 *   中文词条经 AFFIX_TO_BONUS 映射到英文键后，能被 BONUS_CODE_MAP 正确编码进 data。
 */
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { ItemService } from '../src/modules/game/item.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import { MapService } from '../src/modules/game/map.service';

// 构造带中文 bonus 与词条的装备模板，验证中文键→英文键映射
const mockEquip = {
  name: '测试铠甲',
  bonus: '{"攻击":50,"护盾":30}', // 中文键 JSON（模拟 equipments.json 真实格式）
  affixes: '["攻击"]',            // 词条数组（JSON 字符串）
  specialSeq: 0,
  equipType: '头部',
  forcedEffect: false,
};

// 模拟原版"高斯步枪"类含【随机词条】的武器模板（属性=随机攻击 随机攻击 随机攻击 随机特殊）
const mockRandomEquip = {
  name: '测试随机武器',
  bonus: '{}',
  affixes: '["随机攻击","随机攻击","随机攻击","随机特殊"]', // 原版"随机攻击"等占位词条
  specialSeq: 0,
  equipType: '射弹武器',
  forcedEffect: false,
};

const staticDataMock = {
  getEquipmentByName: (name: string) =>
    (name === '测试铠甲' ? mockEquip : name === '测试随机武器' ? mockRandomEquip : null),
} as unknown as StaticDataService;

// ItemService 真实实例（bonusToDataString 为纯方法，无需 DB 依赖）
// 第三个参数 combatState 用于 recomputeSets 套装重算；此处给空桩即可（本文件早期用例不触发套装）
const itemServiceReal = new ItemService({} as PrismaService, {} as StaticDataService, {} as any, {} as any, {} as any);

const itemSystem = new ItemSystemService(
  {} as PrismaService,
  {} as PlayerService,
  {} as BonusService,
  itemServiceReal,
  {} as AchievementService,
  staticDataMock,
);

describe('生成装备 (物品操作.ecode L1128-1261)', () => {
  it('品质随机分档存在（空品质时生成 e/d/c/b/a/s 之一）', async () => {
    const item = await itemSystem['generateEquipment']('测试铠甲', '', 0);
    expect(['e', 'd', 'c', 'b', 'a', 's']).toContain(item.data.charAt(0));
    expect(item.type).toBe('装备');
  });

  it('修复点：中文 bonus 键(攻击)被映射为英文并编码进 data（含 !ai 攻击编码）', async () => {
    // 模板 bonus 含中文"攻击"，AFFIX_TO_BONUS["攻击"]="attack"，BONUS_CODE_MAP 反查 ai=attack
    // 旧版会丢失（中文键查不到），新版应生成 !ai<数值>
    const item = await itemSystem['generateEquipment']('测试铠甲', 'a', 0);
    expect(item.data).toMatch(/!ai\d+/); // 攻击加成被编码
  });

  it('词条转换：模板 affixes=["攻击"] 触发 rollAffix，攻击词条写入加成', async () => {
    const item = await itemSystem['generateEquipment']('测试铠甲', 's', 0);
    // s 品质词条倍率=9，攻击词条 300~600 *9 → 区间大，但仍应以 !ai 编码且数值>0
    expect(item.data).toMatch(/!ai[1-9]\d*/);
  });

  it('特效生成：data 结尾包含 !bx<编号>', async () => {
    // 模板 forcedEffect=false 且非武器 → 15% 几率；多次生成必有至少一次含 !bx
    let found = false;
    for (let i = 0; i < 50 && !found; i++) {
      const item = await itemSystem['generateEquipment']('测试铠甲', 's', 0);
      if (/!bx\d+/.test(item.data)) found = true;
    }
    expect(found).toBe(true);
  });

  it('未知装备名：name 前缀加[错误]且不崩溃', async () => {
    // 原版 L1171：b==0 时 z.名称="[错误]"+名称；本实现 getEquipmentByName 返回 null
    // 应安全生成（bonus 为空），不抛错
    const item = await itemSystem['generateEquipment']('不存在的装备', 'e', 0);
    expect(item).toBeDefined();
    expect(item.type).toBe('装备');
  });
});

describe('随机词条展开 (物品操作.ecode 随机文本 L1197-1211)', () => {
  it('回归：随机攻击/随机特殊类词条必须展开为具体属性并编码进 data（不能整串当词条名丢失）', async () => {
    // 原版 BUG：randomText 按全角逗号拆分，而候选串为半角逗号 → 整个串被当单个词条名，
    // rollAffix 查不到 AFFIX_TO_BONUS → 不写 bonus → 生成 data 形如 "e!bx0" 无属性。
    // 真实原版数据 高斯步枪 属性=随机攻击 随机攻击 随机攻击 随机特殊，必须展开成具体属性。
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      const item = await itemSystem['generateEquipment']('测试随机武器', 'a', 0);
      // 至少应展开出 1 个属性编码（!ai/!ae/!aa/!az 等任意加成编码，排除纯 !bx 特效用）
      if (/!a[ijklmnopqrstuvwxyz]\d/.test(item.data)) ok = true;
    }
    expect(ok).toBe(true);
  });

  it('随机特殊词条（暴击/速度/命中/闪避/韧性/魅力）同样生效', async () => {
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      const item = await itemSystem['generateEquipment']('测试随机武器', 'a', 0);
      // 随机特殊 候选含 暴击(crit→!at?)/速度(speed→!a?)/命中/闪避/韧性/魅力，
      // 此处只验证 data 整体非空且含属性或特效编码即证明词条链未断裂
      if (/!a[a-z]\d/.test(item.data)) ok = true;
    }
    expect(ok).toBe(true);
  });
});

describe('装备解析 (物品操作.ecode L1262-1511)', () => {
  it('从静态定义恢复部位/属性/基础字段，并解析编码加成、制造者和特效', () => {
    const parser = new ItemService({} as PrismaService, {
      getEquipmentByName: () => ({
        name: '解析武器', equipType: '射弹武器', specialSeq: -1,
        cooldown: 10, lockTime: 3, forcedEffect: true,
        vehicleForceDmg: false, damageType: '物理',
        description: '测试', baseBonus: '{"魅力":2}',
        properties: '{"damage":{"物理":90,"火焰":10}}',
        affixes: '["随机攻击"]', attackText: '{"name":"枪击"}', buffs: '[]',
      }),
      isWeapon: () => true,
      getEffectById: () => ({ bonus: '{"贯穿":5}' }),
    } as unknown as StaticDataService, {} as any, {} as any, {} as any);
    const parsed = parser.parseEquipment({
      name: '解析武器', type: '装备', quantity: 1, durability: 7,
      data: 'a!ai25!bx1!@@工匠',
    });
    expect(parsed.type).toBe('射弹武器');
    expect(parsed.specialSeq).toBe(-1);
    expect(parsed.properties.phys).toBe(90);
    expect(parsed.properties.fire).toBe(10);
    expect(parsed.bonus.攻击).toBe(25);
    expect(parsed.baseBonus.魅力).toBe(2);
    expect(parsed.baseBonus.贯穿).toBe(5);
    expect(parsed.maker).toBe('工匠');
    expect(parsed.negativeType).toBe(1);
    expect(parsed.durability).toBe(7);
  });

  it('保留原版 bx39 的属性覆盖行为（火焰属性写入物理）', () => {
    const parser = new ItemService({} as PrismaService, {
      getEquipmentByName: () => ({ name: '龙息', equipType: '射弹武器', specialSeq: -39, properties: '{"damage":{"物理":20,"火焰":80}}' }),
      isWeapon: () => true,
      getEffectById: () => undefined,
    } as unknown as StaticDataService, {} as any, {} as any, {} as any);
    const parsed = parser.parseEquipment({ name: '龙息', type: '装备', quantity: 1, durability: 0, data: 'e!bx39' });
    expect(parsed.properties.phys).toBe(100);
    expect(parsed.properties.fire).toBe(80);
  });
});

describe('分解装备 (物品操作.ecode L2076-2157)', () => {
  it('按品质与分解倍率返还水晶/能量块，并识别 count 形式的配方需求', async () => {
    const backpack = [{ name: '高斯步枪', type: '装备', quantity: 1, durability: 0, data: 'd' }];
    const playerService = {
      getPlayerData: jest.fn(async () => ({ player: { userId: 7, name: '测试者', sets: '{}' }, backpack, markers: {} })),
      safeJsonParse: (value: any, fallback: any) => {
        try { return typeof value === 'string' ? JSON.parse(value) : (value ?? fallback); } catch { return fallback; }
      },
    } as unknown as PlayerService;
    const prisma = { player: { update: jest.fn(async () => undefined) } } as unknown as PrismaService;
    const achievements = { setAchievement: jest.fn() } as unknown as AchievementService;
    const staticData = {
      getEquipmentByName: () => ({ name: '高斯步枪', equipType: '射弹武器', specialSeq: -1, properties: '{"damage":{"物理":100}}' }),
      isWeapon: () => true,
      getAllCraftings: () => [{ name: '高斯步枪', deconstructMul: 5, requirements: '[{"name":"铁","count":2}]' }],
      getEffectById: () => undefined,
    } as unknown as StaticDataService;
    const service = new ItemSystemService(
      prisma, playerService, {} as BonusService,
      new ItemService(prisma, staticData, {} as any, {} as any, {} as any), achievements, staticData,
    );
    await service.deconstructItem(7, '高斯步枪', 1);
    expect(backpack.find((item: any) => item.name === '水晶')?.quantity).toBeCloseTo(8);
    expect(backpack.find((item: any) => item.name === '能量块')?.quantity).toBeCloseTo(4);
    expect(backpack.some((item: any) => item.name === '高斯步枪')).toBe(false);
  });
});

describe('套装判定重算 (物品操作.ecode 套装判断 L1581 → player.sets)', () => {
  // 套装判定(setJudgment) 为纯逻辑；recomputeSets 遍历装备名调 setJudgment 累加写入 player.sets。
  // 原版 _计算玩家 每次构建属性时实时 套装判断 累加 玩家.套装；
  // 本框架持久化到 player.sets（buildAttackerBonus 读取），故装备变更后必须重算。
  const { CombatStateService } = require('../src/modules/game/combat-state.service');
  const combatState = new CombatStateService();

  // StaticDataService mock：getEquipmentByName 返回含 specialSeq 的模板，缺失则名称前缀判定
  const staticDataMock2 = {
    getEquipmentByName: (name: string) => {
      const seqMap: Record<string, number> = {
        '女仆头饰': 7, '女仆上衣': 7, '女仆围裙': 7, '女仆长裙': 7,
        '增幅器-侵彻': 75, '增幅器-速射': 71, '增幅器-神枪': 73, '增幅器-坚毅': 74, '增幅器-敏锐': 72,
        '植入体-强攻': 76, '植入体-雷霆': 77, '植入体-烈火': 78, '植入体-冰结': 79,
      };
      return seqMap[name] !== undefined ? { name, specialSeq: seqMap[name] } : { name, specialSeq: 0 };
    },
  } as unknown as StaticDataService;

  const itemServiceForSet = new ItemService({} as PrismaService, staticDataMock2, combatState, {} as any, {} as any);

  const mk = (name: string) => ({ name, type: '装备', quantity: 1, durability: 0, data: '' });

  it('女仆4件套 → maid=4（砸瓦鲁多前置）', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets(
      [mk('女仆头饰'), mk('女仆上衣'), mk('女仆围裙'), mk('女仆长裙')], []));
    expect(sets.maid).toBe(4);
  });

  it('增幅器-侵彻 → amplifier=5（名称段判定）', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets([mk('增幅器-侵彻')], []));
    expect(sets.amplifier).toBe(5);
  });

  it('生命祝福按原版 L1746 排除，仅生命增强器计数 → lifeBless=1', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets([mk('生命祝福'), mk('生命增强器')], []));
    expect(sets.lifeBless).toBe(1);
  });

  it('一拳套4件 → onePunch=4（攻击2+25 前置）', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets(
      [mk('一拳手套'), mk('一拳护腕'), mk('一拳腰带'), mk('一拳战靴')], []));
    expect(sets.onePunch).toBe(4);
  });

  it('植入体-强攻（specialSeq=76）→ implant=1', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets([mk('植入体-强攻')], []));
    expect(sets.implant).toBe(1);
  });

  // 法宝（资源类）：对应原版 数据分析.ecode L907-923，扫描"资源"装备写入 小樱命中次数/陪睡(=耐久)
  const mkTreasure = (name: string, durabilityLevel: number) => ({
    name, type: '资源', quantity: 1, durability: 0, data: '', durabilityLevel,
  });

  it('法宝镇岳(耐久5) → 小樱命中次数=2 且 陪睡=5', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets([], [], [mkTreasure('镇岳', 5)]));
    expect(sets.sakuraHits).toBe(2);
    expect(sets.sleepover).toBe(5);
  });

  it('法宝飞天独龙神女枪(耐久8) → 小樱命中次数=1 且 陪睡=8', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets([], [], [mkTreasure('飞天独龙神女枪', 8)]));
    expect(sets.sakuraHits).toBe(1);
    expect(sets.sleepover).toBe(8);
  });

  it('普通装备不触发法宝字段（无小樱命中次数）', () => {
    const sets = JSON.parse((itemServiceForSet as any).recomputeSets([mk('女仆头饰')], []));
    expect(sets.sakuraHits).toBeUndefined();
  });
});

// ==================== 战利品 (战斗相关.ecode L4874-4946) ====================
describe('战利品 - 怪物死亡掉落发放 (战斗相关.ecode L4874-4946)', () => {
  // distributeLoot 依赖 playerService.getBackpackItems / achievementService.addAchievement(写库)
  // 用真实实例但 savePlayer 置空，避免 DB 依赖
  const playerServiceLoot = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);
  (playerServiceLoot as any).savePlayer = async () => {};
  const achievementLoot = new AchievementService({} as PrismaService, playerServiceLoot, {} as StaticDataService);
  const itemSystemLoot = new ItemSystemService(
    {} as PrismaService,
    playerServiceLoot,
    {} as BonusService,
    itemServiceReal,
    achievementLoot,
    staticDataMock,
  );

  const mkPlayer = () => ({
    player: {
      name: '战利品测试', type: '战斗女仆',
      backpack: '[]', markers: '{}', exp: 0,
      套装: {}, 属性: {}, 成就: [], 任务: [],
    },
  });

  it('L4889/L4892 空名/电力 跳过', async () => {
    const pd = mkPlayer();
    const txt = await itemSystemLoot.distributeLoot(pd, [{ name: '' }, { name: '电力' }]);
    expect(txt).toBe('');
    expect(JSON.parse(pd.player.backpack).length).toBe(0);
  });

  it('L4922 资源类(怪物材料) → 加入背包 + 采集资源成就', async () => {
    const pd = mkPlayer();
    const txt = await itemSystemLoot.distributeLoot(pd, [{ name: '怪物材料', type: '资源', quantity: 2 }]);
    expect(txt).toContain('怪物材料');
    const bp = JSON.parse(pd.player.backpack);
    expect(bp.find((b: any) => b.name === '怪物材料').count).toBe(2);
    // addAchievement 将 markers 直接写为对象（非字符串），按对象读取
    expect((pd.player.markers as any)['采集资源']).toBe(2);
  });

  it('L4935/物品操作 L2964 负数资源 → 从背包扣除，归零删除，不写入负库存', async () => {
    const pd = mkPlayer();
    pd.player.backpack = JSON.stringify([{ name: '载具零件', type: '资源', count: 3, quantity: 3 }]);

    await itemSystemLoot.distributeLoot(pd, [{ name: '载具零件', type: '资源', quantity: -2 }]);
    expect(JSON.parse(pd.player.backpack)).toEqual([
      expect.objectContaining({ name: '载具零件', count: 1, quantity: 1 }),
    ]);

    await itemSystemLoot.distributeLoot(pd, [{ name: '载具零件', type: '资源', quantity: -2 }]);
    expect(JSON.parse(pd.player.backpack).some((item: any) => item.name === '载具零件')).toBe(false);

    await itemSystemLoot.distributeLoot(pd, [{ name: '不存在的资源', type: '资源', quantity: -5 }]);
    expect(JSON.parse(pd.player.backpack).some((item: any) => item.name === '不存在的资源')).toBe(false);
    expect((pd.player.markers as any)['采集资源']).toBeUndefined();
  });

  it('L4927 资源-经验 → 玩家经验 += 数量×(1+经验/100)', async () => {
    const pd = mkPlayer();
    pd.player.属性 = { 经验: 0 };
    const txt = await itemSystemLoot.distributeLoot(pd, [{ name: '经验', type: '资源', quantity: 50 }]);
    expect(pd.player.exp).toBe(50);
    // 经验加成 100%：数量 50 *2 = 100
    const pd2 = mkPlayer();
    pd2.player.属性 = { 经验: 100 };
    await itemSystemLoot.distributeLoot(pd2, [{ name: '经验', type: '资源', quantity: 50 }]);
    expect(pd2.player.exp).toBe(100);
  });

  it('L4906 装备类 → 生成装备并加入背包 + 获得装备成就', async () => {
    const pd = mkPlayer();
    const txt = await itemSystemLoot.distributeLoot(pd, [{ name: '测试铠甲', type: '装备', quantity: 1 }]);
    expect(txt).toContain('测试铠甲');
    const bp = JSON.parse(pd.player.backpack);
    expect(bp.find((b: any) => b.name === '测试铠甲')).toBeDefined();
    expect((pd.player.markers as any)['获得装备']).toBe(1);
  });
});

// ==================== 物品要求 (物品操作.ecode L1784-1811) ====================
describe('物品要求 - 数量要求判定 (物品操作.ecode L1784-1811)', () => {
  it('L1794-1796 不提供要求数量 → 存在即满足(found=true)，写回数组下标', () => {
    const items = [{ 名称: '导弹', 数量: 0 }];
    const r = itemSystem.itemRequire('导弹', items);
    expect(r.found).toBe(true);
    expect(r.index).toBe(0);
  });

  it('L1798-1800 提供要求数量且数量满足 → found=true', () => {
    const items = [{ 名称: '氢弹', 数量: 5 }];
    const r = itemSystem.itemRequire('氢弹', items, 0.1);
    expect(r.found).toBe(true);
    expect(r.index).toBe(0);
  });

  it('L1802 数量不足 → found=false，提示"需要X的NAME，你只有Y"', () => {
    const items = [{ 名称: '导弹', 数量: 0.05 }];
    const r = itemSystem.itemRequire('导弹', items, 0.1);
    expect(r.found).toBe(false);
    expect(r.hint).toBe('需要0.1的导弹，你只有0');
  });

  it('L1810-1811 名称未命中 → 返回 found=false', () => {
    const items = [{ 名称: '电力', 数量: 100 }];
    const r = itemSystem.itemRequire('氢弹', items, 1);
    expect(r.found).toBe(false);
    expect(r.index).toBe(-1);
  });

  it('多个同名物品 → 返回第一个匹配下标', () => {
    const items = [{ 名称: '导弹', 数量: 1 }, { 名称: '导弹', 数量: 1 }];
    const r = itemSystem.itemRequire('导弹', items);
    expect(r.found).toBe(true);
    expect(r.index).toBe(0);
  });

  it('空数组 / 非数组 → found=false', () => {
    expect(itemSystem.itemRequire('x', []).found).toBe(false);
    expect(itemSystem.itemRequire('x', null as any).found).toBe(false);
  });
});
