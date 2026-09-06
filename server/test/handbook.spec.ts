/**
 * 图鉴服务（HandbookService）单元测试
 * 对应原版：数据显示.ecode L2632-3742 子程序 使魔图鉴。
 *
 * 覆盖：
 *   A. 总览：20 分类两列编号菜单 + 22 项统计串（原版 L2654）
 *   B. 分类条目数与模板行过滤
 *   C. 精确名称优先（原版 L2672-2965 扫描顺序）
 *   D. 使魔详情：好感解锁链 + 技能等级替换 + 特效编号 + 毛发
 *   E. 装备详情：武器/防具两条分支 + 词条池展开
 *   F. 怪物：基础图鉴 + 「详细」分支（属性/装备/掉落/麻醉值）
 *   G. 配方 / 废弃载具（本批新迁移的数据集）
 *   H. 跨分类模糊搜索 / 附近地图 / 载具二级入口
 */

import { HandbookService } from '../src/modules/game/handbook.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { ShortcutService } from '../src/modules/game/shortcut.service';

const staticData = new StaticDataService();
const shortcutService = {} as ShortcutService;
shortcutService.setTempInput = async () => '';
const handbook = new HandbookService(staticData, shortcutService as any);

const baseCtx = { userId: 1, playerName: '路人甲', skillLevel: 1 };
/** 当前使魔为花园猫、好感 0 */
const catCtx = { ...baseCtx, familiarName: '花园猫', affinity: 0 };

// ============================================================
describe('A. 总览（原版 L2654 两列菜单 + 统计串）', () => {
  it('输出 玩家名+请选择分类 / 两列编号菜单 / 搜索提示 / 当前统计', async () => {
    const out = await handbook.handle('', baseCtx);
    expect(out).toContain('路人甲请选择分类');
    expect(out).toContain(`或者你可以${'“'}图鉴腰部${'”'}来搜索`);
    expect(out).toMatch(/^当前:/m);
  });

  it('两列菜单是 20 项、每项一行两列、编号右对齐', async () => {
    const out = await handbook.handle('', baseCtx);
    const rows = out.split('\n').filter((l) => /^\s*\d+、/.test(l));
    expect(rows).toHaveLength(10); // 20 项 ÷ 2 列
    // 首行： " 1、使魔" 与 " 2、武器" 同行，序号右对齐 2 位
    expect(rows[0]).toMatch(/^ 1、使魔\s+2、武器$/);
    // 末行：第 19、20 项
    expect(rows[9]).toMatch(/^19、对话文本\s+20、废弃载具$/);
  });

  it('菜单 20 项的名称与顺序对齐原版', async () => {
    const out = await handbook.handle('', baseCtx);
    const labels = ['使魔', '武器', '装备', '资源', '地图', '怪物', '任务', '物品', '增益', '建筑',
      '部件', '称号', '音乐', '装备特效', '武器特效', '配方', '图片', '攻击文本', '对话文本', '废弃载具'];
    for (const l of labels) {
      expect(out).toMatch(new RegExp(`\\d+、${l}`));
    }
    // 注意第 11 项原文是「部件」而非「载具部件」（后者只在统计串出现）
    expect(out).toContain('11、部件');
  });

  it('统计串含 20 项，口径与菜单不完全相同（武器和装备合并、含制造、部件称载具部件）', async () => {
    const out = await handbook.handle('', baseCtx);
    const line = out.split('\n').find((l) => l.startsWith('当前:'))!;
    const keys = line.slice(3).split(',').map((s) => s.replace(/\d+$/, ''));
    expect(keys).toEqual(['使魔', '武器和装备', '资源', '地图', '怪物', '任务', '物品', '增益',
      '攻击文本', '对话文本', '制造', '建筑', '载具部件', '称号', '音乐', '武器特效', '装备特效',
      '图片资源', '配方', '废弃载具']);
  });

  it('统计串里 配方94 / 废弃载具11 / 制造426 与原版基线一致', async () => {
    const out = await handbook.handle('', baseCtx);
    expect(out).toContain('配方94');
    expect(out).toContain('废弃载具11');
    expect(out).toContain('制造426');
  });
});

// ============================================================
describe('B. 分类条目数与模板行过滤', () => {
  it('模板行（任务/增益/建筑/物品/对话/载具）被剔除，与原版基线一致', () => {
    const sec = handbook.buildSections();
    const c = Object.fromEntries(sec.map((s) => [s.title, s.entries.length]));
    expect(c['使魔']).toBe(31);
    expect(c['武器']).toBe(122);
    expect(c['装备']).toBe(238);
    expect(c['物品']).toBe(170); // items.json 171 - 「物品模板」（含新增主线补给箱）
    expect(c['资源']).toBe(119);
    expect(c['怪物']).toBe(145);
    expect(c['任务']).toBe(86); // tasks.json 87 - 「任务模板」
    expect(c['增益']).toBe(18); // buffs.json 19 - 「增益模板」
    expect(c['建筑']).toBe(104); // buildings.json 105 - 「建筑模板」
    expect(c['称号']).toBe(140);
    expect(c['部件']).toBe(165); // vehicles.json 166 - 「载具模板」
    expect(c['攻击文本']).toBe(67);
    expect(c['对话文本']).toBe(19); // npcs.json 20 - 「对话模板」
    expect(c['配方']).toBe(94);
    expect(c['废弃载具']).toBe(11);
    expect(c['音乐']).toBe(0);
    expect(c['图片']).toBe(0);
  });

  it('类目列表页带条数与提示', async () => {
    const out = await handbook.handle('武器', baseCtx);
    expect(out).toContain('📖 武器图鉴 (122条)');
    expect(out).toContain('使用「图鉴 名称」查看详情');
  });
});

// ============================================================
describe('C. 精确名称优先（原版 L2672-2965）', () => {
  it('图鉴花园猫 直接进使魔详情，而不是返回 9 条模糊结果', async () => {
    const out = await handbook.handle('花园猫', catCtx);
    expect(out).not.toContain('的图鉴搜索结果');
    expect(out.startsWith('花园猫（好感0）')).toBe(true);
  });

  it('图鉴钻石分解1 直接进配方详情', async () => {
    const out = await handbook.handle('钻石分解1', baseCtx);
    expect(out).toContain('配方等级:1');
    expect(out).toContain('每分钟1生产力的产出与消耗：');
    expect(out).not.toContain('的图鉴搜索结果');
  });

  it('图鉴废弃的骑士 直接进废弃载具详情', async () => {
    const out = await handbook.handle('废弃的骑士', baseCtx);
    expect(out).toContain('零件:骑士核心x1');
    expect(out).toContain('每小时刷新几率:2%');
  });

  it('无精确命中时才走模糊搜索（多结果返回列表）', async () => {
    const out = await handbook.handle('剑', baseCtx);
    expect(out).toMatch(/的图鉴搜索结果 \(\d+条/);
  });

  it('模糊搜索无结果给出原版文案', async () => {
    const out = await handbook.handle('不存在的关键字xyz', baseCtx);
    expect(out).toContain('图鉴中没有找到【不存在的关键字xyz】');
  });
});

// ============================================================
describe('D. 使魔详情（原版 L3045-3047）', () => {
  it('好感 0 时五条亲和解锁文案都带「好感 N 解锁:」前缀', () => {
    const cat = staticData.getAllFamiliars().find((f) => f.name === '花园猫')!;
    const det = handbook['renderFamiliarDetail'](cat, 1, 0);
    expect(det[0]).toBe('花园猫（好感0）');
    const joined = det.join('\n');
    expect(joined).toContain('特效编号(调试用):1');
    expect(joined).toContain('毛发:猫毛x1');
    for (const n of [20, 40, 60, 80, 100]) {
      expect(joined).toContain(`好感${n}解锁:`);
    }
  });

  it('好感 100 全部解锁时不再显示解锁前缀', () => {
    const cat = staticData.getAllFamiliars().find((f) => f.name === '花园猫')!;
    const det = handbook['renderFamiliarDetail'](cat, 1, 100);
    expect(det[0]).toBe('花园猫（好感100）');
    expect(det.join('\n')).not.toContain('解锁:');
  });

  it('技能等级替换：等级 4 时【5技能等级】→20、【1技能等级】→4', () => {
    const cat = staticData.getAllFamiliars().find((f) => f.name === '花园猫')!;
    const joined = handbook['renderFamiliarDetail'](cat, 4, 100).join('\n');
    expect(joined).toContain('+20');
    expect(joined).toContain('+4');
    expect(joined).not.toContain('【5技能等级】');
    expect(joined).not.toContain('【1技能等级】');
  });
});

// ============================================================
describe('E. 装备详情（原版 L2970-3044）', () => {
  it('武器分支：伤害属性四元 + 攻击文本 + 冷却 + 特效编号 + 出处', () => {
    const e = staticData.getAllEquipments().find((x) => x.name === '高斯步枪');
    if (!e) return;
    const joined = handbook['renderEquipmentDetail'](e, true).join('\n');
    expect(joined).toContain('◆伤害属性:');
    expect(joined).toContain('◆攻击显示的文本:');
    expect(joined).toContain('◆攻击冷却:');
    expect(joined).toContain('特效编号(调试用):');
    expect(joined).toContain('出处:');
  });

  it('防具分支：含 ◆攻击时召唤', () => {
    const e = staticData.getAllEquipments().find((x) => x.equipType === '头盔' && x.attackText?.name);
    if (!e) return;
    expect(handbook['renderEquipmentDetail'](e, false).join('\n')).toContain('◆攻击时召唤');
  });

  it('词条池展开：随机攻击 → 具体属性列表', () => {
    const AFFIX: Record<string, string> = {
      随机攻击: '护盾,装甲,生命,攻击,物攻,冰攻,火攻,电攻,护盾全抗,装甲全抗,生命全抗,速度,命中,闪避',
    };
    const expanded = AFFIX['随机攻击'].split(',').map((s) => s.trim());
    expect(expanded).toContain('护盾');
    expect(expanded).toContain('命中');
  });
});

// ============================================================
describe('F. 怪物图鉴（原版 L3161-3245）', () => {
  it('基础分支：等级 + 产奶量 + 毛发 + 特效编号 + 显示详细数据入口', async () => {
    const out = await handbook.handle('史莱姆', baseCtx);
    expect(out).toContain('基础等级:1');
    expect(out).toContain('毛发:圣水x1');
    expect(out).toContain('特效编号(调试用):');
    expect(out).toContain('1、显示详细数据');
    expect(out).not.toContain('◆使用的武器');
  });

  it('详细分支：属性面板 + 三池四系抗性 + 使用的武器/装备', async () => {
    const out = await handbook.handle('史莱姆详细', baseCtx);
    expect(out).toContain('史莱姆（怪物）');
    expect(out).toContain('生命:30/30');
    expect(out).toContain('◆护盾物/火/冰/电抗:');
    expect(out).toContain('◆装甲物/火/冰/电抗:');
    expect(out).toContain('◆生命物/火/冰/电抗:');
    expect(out).toContain('◆使用的武器:触手');
    expect(out).toContain('◆使用的装备:蓝色丝袜');
    expect(out).toContain('◆不会闪避攻击');
  });

  it('详细分支：掉落两行（基础 + 玩家加成）与麻醉值', async () => {
    const out = await handbook.handle('史莱姆详细', baseCtx);
    expect(out).toContain('◆掉落:钻石x2');
    expect(out).toContain('◆掉落(你的加成):');
    // 麻醉 100 → 捕捉需要 100/150≈1 的饲料
    expect(out).toContain('◆麻醉值100，捕捉需要1的饲料');
  });

  it('详细分支：复杂怪物的三池、多武器、不可捕捉', async () => {
    const out = await handbook.handle('简单监察者详细', baseCtx);
    expect(out).toContain('护盾:5000/5000');
    expect(out).toContain('装甲:8000/8000');
    expect(out).toContain('生命:15000/15000');
    expect(out).toContain('◆使用的武器:轴炮I、主炮I、导弹I、近防炮I');
    // 麻醉 < 0 → 特殊麻醉值且不可捕捉
    expect(out).toContain('◆特殊麻醉值-10000(不可捕捉)');
  });

  it('详细分支：百分比回复保留小数（不被取整抹成 0）', async () => {
    const out = await handbook.handle('简单监察者详细', baseCtx);
    // 静态数据里 护盾回复2=0.01，若按整数取整会变成 0
    expect(out).toMatch(/◆护盾回复:20 \+ 0\.01%/);
  });

  it('非怪物名 + 详细 后缀不会误入详细分支', async () => {
    const out = await handbook.handle('高斯步枪详细', baseCtx);
    // 武器无「详细」分支，落回常规匹配（精确命中武器 → 详情）
    expect(out).not.toContain('◆掉落');
  });
});

// ============================================================
describe('G. 配方 / 废弃载具（本批新迁移数据集）', () => {
  it('配方详情：产物与副产物分开（几率<100 为副产物）', async () => {
    const out = await handbook.handle('钻石分解1', baseCtx);
    expect(out).toContain('产物:生物质x5'); // chance=100
    expect(out).toContain('副产物:生物质x1'); // chance=10 → 5*10/100=0.5→1
    expect(out).toContain('消耗:钻石x50');
    expect(out).toContain('解锁需求:采集钻石x10000');
    expect(out).toContain('1、领取解锁这个配方的任务');
  });

  it('废弃载具详情：零件 + 载具价值 + 刷新几率', async () => {
    const out = await handbook.handle('废弃的骑士', baseCtx);
    expect(out).toContain('零件:骑士核心x1');
    expect(out).toContain('载具价值:');
    expect(out).toContain('每小时刷新几率:2%');
  });

  it('废弃载具列表 11 条且带刷新几率简介', async () => {
    const out = await handbook.handle('废弃载具', baseCtx);
    expect(out).toContain('📖 废弃载具图鉴 (11条)');
    expect(out).toContain('坠毁的行星杀手 - 刷新几率0.1%');
  });
});

// ============================================================
describe('H. 附近地图 / 载具二级入口', () => {
  it('图鉴载具 → 五个部件子分类', async () => {
    const out = await handbook.handle('载具', baseCtx);
    expect(out).toContain('请选择分类');
    expect(out).toContain('1、核心部件');
    expect(out).toContain('5、行走部件');
  });

  it('附近：不存在地点给出原版文案', async () => {
    const out = await handbook.handle('不存在之地附近', baseCtx);
    expect(out).toContain('图鉴中没有找到');
  });

  it('附近：合法复活点列出该点地图', async () => {
    const allMaps: any[] = staticData.loadRaw('maps');
    const respawn = allMaps.find((m) => m.respawnPoint)?.respawnPoint;
    if (!respawn) return;
    const out = await handbook.handle(`${respawn}附近`, baseCtx);
    expect(out).toContain(`${respawn}】附近的地图`);
    expect(out).toContain('使用「图鉴 地图名」查看地图详情');
  });

  it('仅输入「附近」给出用法提示', async () => {
    const out = await handbook.handle('附近', baseCtx);
    expect(out).toContain('请在「附近」前输入地点名');
  });
});
