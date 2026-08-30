/**
 * 显示名派生单元测试（对应原版 加成计算.ecode L1616-1623 _计算玩家）：
 *   名称 = 图片(baseName) + [佩戴称号]，全空回退 类型。
 */
import { deriveDisplayName } from '../src/modules/game/display-name.util';

describe('deriveDisplayName 显示名派生（原版 名称=图片+[称号]）', () => {
  it('基础名 + 佩戴中的称号 → 名字带[称号]后缀', () => {
    const player = {
      baseName: '白',
      type: '白',
      titles: [{ name: '新人', equipped: true }, { name: '肝帝I', equipped: false }],
    };
    expect(deriveDisplayName(player)).toBe('白[新人]');
  });

  it('称号存在但未佩戴 → 不加后缀', () => {
    const player = {
      baseName: '白',
      type: '白',
      titles: [{ name: '新人', equipped: false }],
    };
    expect(deriveDisplayName(player)).toBe('白');
  });

  it('多个佩戴标记时取第一个（数据异常兜底，不叠加）', () => {
    const player = {
      baseName: '白',
      titles: [{ name: '新人', equipped: true }, { name: '肝帝I', equipped: true }],
    };
    expect(deriveDisplayName(player)).toBe('白[新人]');
  });

  it('titles 为 JSON 字符串（行表示）同样可派生', () => {
    const player = {
      baseName: '白',
      titles: JSON.stringify([{ name: '新人', equipped: true }]),
    };
    expect(deriveDisplayName(player)).toBe('白[新人]');
  });

  it('旧形状 titles（字符串数组，旧自动发放）视为未佩戴', () => {
    const player = { baseName: '白', titles: ['新人', '肝帝I'] };
    expect(deriveDisplayName(player)).toBe('白');
  });

  it('titles 含 null/非对象条目不崩溃', () => {
    const player = { baseName: '白', titles: [null, '新人', { name: '肝帝I', equipped: true }] };
    expect(deriveDisplayName(player)).toBe('白[肝帝I]');
  });

  it('基础名与佩戴称号均空 → 回退 使魔名（原版 名称=="" → 玩家.类型）', () => {
    expect(deriveDisplayName({ baseName: '', type: '伊卡洛斯', titles: [] })).toBe('伊卡洛斯');
  });

  it('基础名空但佩戴称号 → 按原版顺序输出 [称号]（后缀在回退判定之前拼接）', () => {
    expect(deriveDisplayName({ baseName: '', type: '伊卡洛斯', titles: [{ name: '新人', equipped: true }] }))
      .toBe('[新人]');
  });

  it('titles 为非法 JSON 字符串时按无称号处理', () => {
    expect(deriveDisplayName({ baseName: '白', titles: '{bad json' })).toBe('白');
  });

  it('baseName 缺省（未迁移/极端桩数据）按空串处理，不抛错', () => {
    expect(deriveDisplayName({ type: '白', titles: [] })).toBe('白');
    expect(deriveDisplayName(null)).toBe('');
    expect(deriveDisplayName(undefined)).toBe('');
  });
});
