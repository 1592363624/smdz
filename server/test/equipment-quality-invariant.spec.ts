/**
 * 装备品质码不变量门禁（2026-09-10）
 *
 * 背景：原版唯一的装备构造入口是「生成装备」（物品操作.ecode L1128-1261），
 * 其数据串恒为 `品质 + 加成转数据(z.加成) + "!bx" + 特效` —— **首字符必然是品质码**
 * （e/d/c/b/a/s；空则掷骰必落其一）。原版其余入包路径全是从已有装备复制数据串，
 * 因此**原版不存在无品质码的装备**（「时间主宰」这类裸条目是本项目 GM 发放引入的）。
 *
 * 该不变量下沉到背包写入唯一出口 item-normalize.mergeBackpackItem：
 * 装备条目数据串缺合法品质码时前置补最低档 E，保证「背包/装备栏里的装备一定带品质码」。
 */
import { mergeBackpackItem } from '../src/modules/game/item-normalize.util';

/** 静态定义桩：只把「冰雹」认成装备 */
const LOOKUP = {
  isEquipment: (name: string) => name === '冰雹',
  itemTypeName: () => undefined as string | undefined,
};

function push(item: any): any[] {
  const bp: any[] = [];
  mergeBackpackItem(bp, item, LOOKUP);
  return bp;
}

describe('装备品质码不变量（入包唯一出口）', () => {
  it('无 data 的装备条目 → 补最低档 E', () => {
    const bp = push({ name: '冰雹', type: '装备', count: 1 });
    expect(bp).toHaveLength(1);
    expect(bp[0].data).toBe('e');
    expect(bp[0].type).toBe('装备');
  });

  it('已有合法品质码 → 原样保留（不得覆盖既有词条数据）', () => {
    const bp = push({ name: '冰雹', type: '装备', data: 's!ac1!bx3' });
    expect(bp[0].data).toBe('s!ac1!bx3');
  });

  it('数据串首字符不是品质码 → 前置补 E，保留原编码内容', () => {
    const bp = push({ name: '冰雹', type: '装备', data: '!bx3' });
    expect(bp[0].data).toBe('e!bx3');
  });

  it('中文旧字段「数据」同步补齐（双字段镜像不分裂）', () => {
    const bp = push({ name: '冰雹', type: '装备', 数据: '' });
    expect(bp[0].data).toBe('e');
    expect(bp[0].数据).toBe('e');
  });

  it('装备不参与合并：同名两件各自入包（词条唯一）', () => {
    const bp: any[] = [];
    mergeBackpackItem(bp, { name: '冰雹', type: '装备', data: 'e' }, LOOKUP);
    mergeBackpackItem(bp, { name: '冰雹', type: '装备', data: 's' }, LOOKUP);
    expect(bp).toHaveLength(2);
    expect(bp.map((i) => i.data)).toEqual(['e', 's']);
  });

  it('非装备条目不受影响（仍按名称合并数量）', () => {
    const bp: any[] = [];
    mergeBackpackItem(bp, { name: '木头', count: 2 }, LOOKUP);
    mergeBackpackItem(bp, { name: '木头', count: 3 }, LOOKUP);
    expect(bp).toHaveLength(1);
    expect(bp[0].count).toBe(5);
  });
});
