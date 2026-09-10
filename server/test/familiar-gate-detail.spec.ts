/**
 * 使魔契约引导页 DTO 解析单元测试。
 *
 * 覆盖点：
 * 1. description2 的结构化解析（定位/专精/优点/操作难度）与 #换行 转换；
 * 2. 存量脏数据形态——叙述与字段粘连在同一行（伊芙利特实证）、复合定位（辅助/输出）；
 * 3. 专精取值超出常规枚举时（制造/远程武器）不得丢字段或抛错；
 * 4. 与真实 familiars.json 对照：可契约集合 = `!noSummon` 过滤，且每条必备字段齐全
 *    （守住「Web 引导页与文本门禁同一份数据、同一套过滤」这一单源约定）。
 */
import { buildFamiliarGateDetail, plainGameText } from '../src/modules/game/familiar-menu.util';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawFamiliars = require('../prisma/data/familiars.json');
const allFamiliars: any[] = Array.isArray(rawFamiliars) ? rawFamiliars : rawFamiliars.data;

describe('plainGameText 换行哨兵归一', () => {
  it('#换行 → 真换行；空值 → 空串', () => {
    expect(plainGameText('A#换行B')).toBe('A\nB');
    expect(plainGameText(null)).toBe('');
    expect(plainGameText(undefined)).toBe('');
  });
});

describe('buildFamiliarGateDetail 结构化解析', () => {
  const mk = (description2: string, extra: Record<string, any> = {}) => ({
    name: '测试使魔',
    specialSeq: 99,
    uniqueSkill: '测试技能！',
    description2,
    description: '特性：测试#换行第二行',
    skillDesc: '主动技能：测试用',
    affinityDesc: ['一档', '二档'],
    ...extra,
  });

  it('标准四段式：定位/专精/优点/操作难度 全部解析', () => {
    const [e] = buildFamiliarGateDetail([
      mk('定位:辅助    专精:雷电#换行优点:全体复活、全体回复#换行操作难度:超超低'),
    ]);
    expect(e.roleTags).toEqual(['辅助']);
    expect(e.specialty).toBe('雷电');
    expect(e.merits).toEqual(['全体复活', '全体回复']);
    expect(e.difficulty).toBe('超超低');
    expect(e.difficultyLevel).toBe(1);
    expect(e.elementKey).toBe('thunder');
    expect(e.trait).toBe('特性：测试\n第二行');
    expect(e.awaken).toEqual(['一档', '二档']);
  });

  it('叙述与字段粘连时：字段照常解析，粘连文本归入档案不丢弃', () => {
    const [e] = buildFamiliarGateDetail([
      mk('某人的故事开头#换行使用巨大战斧，恢复如初定位:输出    专精:火焰#换行优点:无敌#换行操作难度:高'),
    ]);
    expect(e.roleTags).toEqual(['输出']);
    expect(e.specialty).toBe('火焰');
    expect(e.merits).toEqual(['无敌']);
    expect(e.flavor).toContain('某人的故事开头');
    expect(e.flavor).toContain('恢复如初');
  });

  it('「设计:」作者署名在展示层被剥离（仅展示层差异，源数据不动）', () => {
    const [e] = buildFamiliarGateDetail([
      mk('设计:某人(12345678**)#换行某人的故事#换行定位:输出    专精:火焰#换行操作难度:高'),
    ]);
    expect(e.flavor).not.toContain('设计:');
    expect(e.flavor).toContain('某人的故事');

    // 署名与结构化字段粘连在同一行时，同样只剥离署名、保留其余档案文本
    const [e2] = buildFamiliarGateDetail([
      mk('设计:某人(12345678**)定位:输出    专精:火焰#换行使用战斧作战#换行操作难度:高'),
    ]);
    expect(e2.flavor).not.toContain('设计:');
    expect(e2.flavor).toBe('使用战斧作战');
    expect(e2.roleTags).toEqual(['输出']);
  });

  it('复合定位按斜杠拆分；未知专精不丢字段', () => {
    const [e] = buildFamiliarGateDetail([
      mk('定位:辅助/输出    专精:制造#换行优点:输出/坦克切换#换行操作难度:超高'),
    ]);
    expect(e.roleTags).toEqual(['辅助', '输出']);
    expect(e.specialty).toBe('制造');
    expect(e.difficultyLevel).toBe(5);
  });

  it('难度未列举时按关键字降级推断；完全缺失按中性 3', () => {
    const [low, high, unknown] = buildFamiliarGateDetail([
      mk('定位:输出    专精:无#换行操作难度:略低'),
      mk('定位:输出    专精:无#换行操作难度:极高'),
      mk('定位:输出    专精:无'),
    ]);
    expect(low.difficultyLevel).toBe(2);
    expect(high.difficultyLevel).toBe(4);
    expect(unknown.difficultyLevel).toBe(3);
  });

  it('元素归类取命中次数最多者（多系文本时按次数而非出现顺序）', () => {
    const [e] = buildFamiliarGateDetail([
      mk('定位:输出    专精:无#换行优点:火', { description: '火焰火焰火焰，附带一点冰' }),
    ]);
    expect(e.elementKey).toBe('fire');
  });

  it('无 specialization 时元素归类为 none，且不抛错', () => {
    const [e] = buildFamiliarGateDetail([mk('')]);
    expect(e.elementKey).toBe('none');
    expect(e.roleTags).toEqual([]);
    expect(e.merits).toEqual([]);
  });
});

describe('真实 familiars.json 对照（单源：可选集合 = !noSummon 过滤）', () => {
  const selectable = allFamiliars.filter((f) => !f.noSummon);
  const detail = buildFamiliarGateDetail(selectable);

  it('可契约数量与过滤结果一致，且顺序保持静态原始序', () => {
    expect(detail.length).toBe(selectable.length);
    expect(detail.map((d) => d.name)).toEqual(selectable.map((f) => f.name));
  });

  it('每条必备展示字段齐全（名称/特性/难度/定位）', () => {
    const missing = detail.filter(
      (d) => !d.name || !d.trait || !d.difficulty || d.roleTags.length === 0,
    );
    expect(missing.map((m) => m.name)).toEqual([]);
  });

  it('元素归一键与难度星级均落在合法取值域内', () => {
    const elems = new Set(['thunder', 'fire', 'ice', 'physical', 'none']);
    for (const d of detail) {
      expect(elems.has(d.elementKey)).toBe(true);
      expect(d.difficultyLevel).toBeGreaterThanOrEqual(1);
      expect(d.difficultyLevel).toBeLessThanOrEqual(5);
    }
  });
});
