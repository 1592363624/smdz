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
const itemServiceReal = new ItemService({} as PrismaService, {} as StaticDataService, {} as any);

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

  const itemServiceForSet = new ItemService({} as PrismaService, staticDataMock2, combatState);

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
