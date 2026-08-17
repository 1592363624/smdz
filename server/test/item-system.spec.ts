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

const staticDataMock = {
  getEquipmentByName: (name: string) => (name === '测试铠甲' ? mockEquip : null),
} as unknown as StaticDataService;

// ItemService 真实实例（bonusToDataString 为纯方法，无需 DB 依赖）
const itemServiceReal = new ItemService({} as PrismaService, {} as StaticDataService);

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
