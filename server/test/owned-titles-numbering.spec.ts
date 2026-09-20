/**
 * 「使魔称号」已拥有列表
 *
 * 1. 同一系列只显示最高等级（住这了I/II/III → 只留住这了III）。
 * 2. 一行双列压缩高度（OWNED_TITLE_PER_LINE=2）。
 * 3. 注册临时输入 `编号@佩戴称号 称号名`，玩家回数字即可佩戴。
 * 4. 历史字符串形状条目视为已拥有、未佩戴。
 */
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import {
  renderOwnedTitles,
  titleSeriesName,
  titleTierRank,
} from '../src/modules/game/title-menu.util';

function createService(player: any) {
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers: {} })),
    refreshDisplayName: jest.fn(),
    savePlayer: jest.fn(async () => undefined),
  };
  const setTempInput = jest.fn(async () => '临时输入替换已设置');
  const shortcutService = { setTempInput } as any;
  const service = new FamiliarSystemService(
    {} as any,
    playerService,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    shortcutService,
    undefined,
    undefined,
  );
  return { service, shortcutService };
}

describe('已拥有称号：系列名与阶位', () => {
  it('系列名去掉尾部罗马数字', () => {
    expect(titleSeriesName('住这了III')).toBe('住这了');
    expect(titleSeriesName('肝帝II')).toBe('肝帝');
    expect(titleSeriesName('一发入魂IX')).toBe('一发入魂');
    expect(titleSeriesName('新人')).toBe('新人');
  });

  it('阶位按罗马数字比较', () => {
    expect(titleTierRank('住这了I')).toBe(1);
    expect(titleTierRank('住这了III')).toBe(3);
    expect(titleTierRank('住这了IX')).toBe(9);
    expect(titleTierRank('新人')).toBe(1);
  });
});

describe('renderOwnedTitles 版式', () => {
  it('同系列只留最高等级，一行双列，编号与快捷项一致', () => {
    const { text, shortcutEntries } = renderOwnedTitles('剑圣[住这了]', [
      { name: '住这了I', equipped: false },
      { name: '住这了III', equipped: false },
      { name: '肝帝I', equipped: false },
      { name: '住这了II', equipped: false },
      { name: '战神I', equipped: false },
      { name: '战神II', equipped: false },
      { name: '一发入魂I', equipped: false },
      { name: '一发入魂II', equipped: false },
      { name: '一发入魂III', equipped: false },
    ]);

    // 折叠后条目名精确匹配（不能用 not.toContain：住这了III 包含子串 住这了I）
    const entryNames = [...text.matchAll(/\d+、(?:✅)?([^\s]+)/g)].map((m) => m[1]);
    expect(entryNames).toEqual(['住这了III', '肝帝I', '战神II', '一发入魂III']);

    const lines = text.split('\n');
    const body = lines.filter((l) => /、/.test(l) && !l.includes('使用'));
    // 一行双列：两行覆盖 4 个系列
    expect(body[0]).toContain('1、');
    expect(body[0]).toContain('2、');
    expect(body[1]).toContain('3、');
    expect(body[1]).toContain('4、');

    expect(shortcutEntries).toEqual([
      '1@佩戴称号 住这了III',
      '2@佩戴称号 肝帝I',
      '3@佩戴称号 战神II',
      '4@佩戴称号 一发入魂III',
    ]);
    expect(text).toContain('发送编号即可快速佩戴');
  });

  it('佩戴中的最高阶置顶并带 ✅', () => {
    const { text, shortcutEntries } = renderOwnedTitles('剑圣', [
      { name: '肝帝I', equipped: false },
      { name: '住这了III', equipped: true },
      { name: '住这了I', equipped: false },
    ]);
    const entryNames = [...text.matchAll(/\d+、(?:✅)?([^\s]+)/g)].map((m) => m[1]);
    expect(entryNames).toEqual(['住这了III', '肝帝I']);
    expect(text).toContain('1、✅住这了III');
    expect(shortcutEntries[0]).toBe('1@佩戴称号 住这了III');
  });

  it('佩戴的是同系列低阶时，额外保留佩戴项避免 ✅ 消失', () => {
    const { text, shortcutEntries } = renderOwnedTitles('剑圣[住这了]', [
      { name: '住这了I', equipped: true },
      { name: '住这了III', equipped: false },
      { name: '肝帝I', equipped: false },
    ]);

    // 最高阶 + 佩戴中的低阶都展示；未佩戴的中间阶 II 不展示
    const entryNames = [...text.matchAll(/\d+、(?:✅)?([^\s]+)/g)].map((m) => m[1]);
    expect(entryNames).toEqual(['住这了I', '住这了III', '肝帝I']);
    // 佩戴项置顶
    expect(text).toContain('1、✅住这了I');
    expect(shortcutEntries).toEqual([
      '1@佩戴称号 住这了I',
      '2@佩戴称号 住这了III',
      '3@佩戴称号 肝帝I',
    ]);
  });

  it('历史字符串形状：视为已拥有未佩戴', () => {
    const { text, shortcutEntries } = renderOwnedTitles('路人甲', [
      { name: '新人', equipped: false },
      { name: '肝帝I', equipped: false },
    ]);
    expect(text).toContain('1、新人');
    expect(text).toContain('2、肝帝I');
    expect(shortcutEntries).toEqual(['1@佩戴称号 新人', '2@佩戴称号 肝帝I']);
  });
});

describe('FamiliarSystemService.viewTitles', () => {
  it('折叠同系列并注册临时输入编号；佩戴低阶时保留佩戴项', async () => {
    const { service, shortcutService } = createService({
      name: '剑圣[住这了]',
      titles: [
        { name: '住这了I', equipped: true },
        { name: '住这了III', equipped: false },
        { name: '肝帝I', equipped: false },
      ],
    });

    const out = await service.viewTitles(42);

    expect(out).toContain('剑圣[住这了] 的称号列表');
    expect(out).toContain('住这了III');
    expect(out).toContain('✅住这了I');
    expect(out).toContain('肝帝I');
    expect(shortcutService.setTempInput).toHaveBeenCalledWith(
      42,
      ['1@佩戴称号 住这了I', '2@佩戴称号 住这了III', '3@佩戴称号 肝帝I'].join('#'),
    );
  });

  it('无称号时不注册临时输入', async () => {
    const { service, shortcutService } = createService({ name: '路人甲', titles: '[]' });
    const out = await service.viewTitles(42);
    expect(out).toContain('你还没有获得任何称号');
    expect(shortcutService.setTempInput).not.toHaveBeenCalled();
  });
});
