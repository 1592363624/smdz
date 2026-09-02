import { formatDisplayNumber, roundItemQuantity } from '../src/common/utils/game-text.util';

/**
 * 玩家可见数值格式化测试
 * 规则：最多两位小数、去尾零、无限小数显示为 0
 */
describe('formatDisplayNumber 显示格式化', () => {
  it('常规浮点累计长尾收敛到两位小数', () => {
    expect(formatDisplayNumber(0.05176666666666652)).toBe('0.05');
    expect(formatDisplayNumber(12.03333333333333)).toBe('12.03');
    expect(formatDisplayNumber(4.066666666666666)).toBe('4.07');
    expect(formatDisplayNumber(2.033333333333333)).toBe('2.03');
  });

  it('两位内的小数保持不变', () => {
    expect(formatDisplayNumber(1.5)).toBe('1.5');
    expect(formatDisplayNumber(0.05)).toBe('0.05');
    expect(formatDisplayNumber(56.2)).toBe('56.2');
  });

  it('整数不显示小数点与尾零', () => {
    expect(formatDisplayNumber(40)).toBe('40');
    expect(formatDisplayNumber(200)).toBe('200');
    expect(formatDisplayNumber(1)).toBe('1');
  });

  it('非法输入返回 0', () => {
    expect(formatDisplayNumber(NaN)).toBe('0');
    expect(formatDisplayNumber(undefined)).toBe('0');
    expect(formatDisplayNumber(null)).toBe('0');
    expect(formatDisplayNumber('abc')).toBe('0');
  });
});

/**
 * 物品数量计算收敛测试
 * 规则：四舍五入保留两位小数，返回 number，用于存储与逻辑计算
 */
describe('roundItemQuantity 计算收敛', () => {
  it('浮点累加长尾收敛到两位小数', () => {
    expect(roundItemQuantity(0.05176666666666652)).toBe(0.05);
    expect(roundItemQuantity(12.03333333333333)).toBe(12.03);
    expect(roundItemQuantity(4.066666666666666)).toBe(4.07);
    expect(roundItemQuantity(2.033333333333333)).toBe(2.03);
  });

  it('两位内小数与整数保持原值', () => {
    expect(roundItemQuantity(1.5)).toBe(1.5);
    expect(roundItemQuantity(0.05)).toBe(0.05);
    expect(roundItemQuantity(40)).toBe(40);
    expect(roundItemQuantity(101)).toBe(101);
  });

  it('倍数累加不产生长尾', () => {
    // 核心诉求：掉落加成累加后仍是两位精度
    const base = roundItemQuantity(0.05);
    const total = roundItemQuantity(base + roundItemQuantity(0.05) + roundItemQuantity(0.07));
    expect(total).toBe(0.17);
  });

  it('非法输入返回 0', () => {
    expect(roundItemQuantity(NaN)).toBe(0);
    expect(roundItemQuantity(undefined)).toBe(0);
    expect(roundItemQuantity(null)).toBe(0);
    expect(roundItemQuantity('abc')).toBe(0);
  });
});