/**
 * 称号系统
 *
 * 1. 「查看可领取称号」编号快速领取：仅给未领取的称号发号（已领取的不占号），
 *    并注册临时输入替换 `N@领取称号 称号名`（ShortcutService 对纯数字原文精确匹配）。
 * 2. 仅保留原版 140 个称号（titles.json：条件+奖励），无任何自创称号；
 *    进度行格式 `要求名(当前/要求值)`，在线时间用时间格式（数字到时间）。
 * 3. 领取原版称号：条件不足播报差距；满足则发奖励物品进背包。
 * 4. 按系列分组后，组内只展开「已达成待领取的阶位」+「首个未达成的下一阶」，
 *    更高阶位不铺行、不占编号；标题分子仍为未拥有称号总数（收集进度口径）。
 * 5. 可读性口径：已达成项置顶成「✅ 现在就能领」区块（行首 ✅ + 编号优先），
 *    更高阶未达成项进「⏳ 下一阶进度」区块；顶部汇总直接点名可领取称号
 *    （名单超过 GlobalConfig.titlesView.readySummaryNameLimit 时折算「…（共 N 个）」）。
 */
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

/** 构造被测服务：只注入称号链路所需的最小依赖 */
function createService(
  player: any,
  markers: Record<string, any> = {},
  options: {
    /** 原版称号静态配置（titles.json 形状） */
    allTitles?: any[];
    getTitleByName?: (name: string) => any;
    getSkillLevel?: (markers: any, name: string) => number;
  } = {},
) {
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers })),
    getMarkerValue: (_m: any, _key: string) => 0,
    refreshDisplayName: jest.fn(),
    savePlayer: jest.fn(async () => undefined),
  };
  if (options.getSkillLevel) playerService.getSkillLevel = options.getSkillLevel;

  const staticData: any = {
    getAllFamiliars: jest.fn(() => []),
    getAllTitles: jest.fn(() => options.allTitles ?? []),
    getTitleByName: options.getTitleByName ?? jest.fn(() => undefined),
    getItemByName: jest.fn(() => undefined),
    getEquipmentByName: jest.fn(() => undefined),
  };
  const setTempInput = jest.fn(async (_userId: number, _raw: string) => '临时输入替换已设置');
  const shortcutService = { setTempInput } as any;
  const taskService = { advance: jest.fn(async () => '') } as any;
  const highlight = { emit: jest.fn() } as any;
  const service = new FamiliarSystemService(
    {} as any,
    playerService,
    {} as any,
    staticData,
    taskService,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    shortcutService,
    undefined,
    highlight,
  );
  return { service, shortcutService, playerService, staticData, taskService, highlight };
}

describe('查看可领取称号编号菜单', () => {
  it('同一系列尚无阶位达成时，只展开第一阶，更高阶位不铺行不占号', async () => {
    const allTitles = [
      { name: '肝帝I', requirements: [{ name: '发送指令', quantity: 10 }], rewards: [] },
      { name: '肝帝II', requirements: [{ name: '发送指令', quantity: 100 }], rewards: [] },
    ];
    const { service, shortcutService } = createService({ titles: '[]' }, {}, { allTitles });

    const out = await service.viewAvailableTitles(42);

    // 肝帝I 即“下一阶”，唯一展开；肝帝II 由组头“下一阶需”概括，不再铺行
    expect(out).toContain('1、肝帝I');
    expect(out).not.toContain('肝帝II');
    expect(out).toContain('发送编号即可快速领取');
    // 标题分子仍是未拥有总数（2/2），编号只注册展开的第一阶
    expect(out).toContain('可领取的称号（2/2）');
    expect(shortcutService.setTempInput).toHaveBeenCalledWith(42, '1@领取称号 肝帝I');
  });

  it('已达成待领取的阶位全部保留，再追加首个未达成的下一阶', async () => {
    const allTitles = [
      { name: '肝帝I', requirements: [{ name: '发送指令', quantity: 10 }], rewards: [] },
      { name: '肝帝II', requirements: [{ name: '发送指令', quantity: 100 }], rewards: [] },
      { name: '肝帝III', requirements: [{ name: '发送指令', quantity: 1000 }], rewards: [] },
    ];
    const { service, shortcutService } = createService(
      { titles: '[]' },
      { '发送指令': 50 },
      { allTitles },
    );

    const out = await service.viewAvailableTitles(42);

    // 肝帝I 已达成（50>=10）保留可领取；肝帝II 是下一阶（50<100）展开；肝帝III 隐藏
    expect(out).toContain('1、肝帝I');
    expect(out).toContain('2、肝帝II');
    expect(out).not.toContain('肝帝III');
    // 顶部达成计数只统计已达成项
    expect(out).toContain('1 个条件已达成');
    expect(shortcutService.setTempInput).toHaveBeenCalledWith(
      42,
      ['1@领取称号 肝帝I', '2@领取称号 肝帝II'].join('#'),
    );
  });

  it('已领取的称号不发号不占号：编号只落在可领取项上', async () => {
    const allTitles = [
      { name: '肝帝I', requirements: [{ name: '发送指令', quantity: 10 }], rewards: [] },
      { name: '仓鼠I', requirements: [{ name: '采集资源', quantity: 10 }], rewards: [] },
    ];
    const { service, shortcutService } = createService(
      { titles: [{ name: '肝帝I', equipped: false }] },
      {},
      { allTitles },
    );

    const out = await service.viewAvailableTitles(42);

    // 已领取项不出现在可领取列表
    expect(out).not.toContain('肝帝I');
    // 后续第一个可领取项仍从 1 开始
    expect(out).toContain('1、仓鼠I');
    const registered = shortcutService.setTempInput.mock.calls[0][1] as string;
    expect(registered).toContain('1@领取称号 仓鼠I');
  });

  it('原版称号显示进度行（普通成就/在线时间时间格式/*模糊匹配）', async () => {
    const allTitles = [
      { name: '肝帝II', requirements: [{ name: '发送指令', quantity: 100 }], rewards: [] },
      { name: '住这了I', requirements: [{ name: '在线时间', quantity: 3600 }], rewards: [] },
      { name: '巨人猎手I', requirements: [{ name: '*巨人', quantity: 10 }], rewards: [] },
    ];
    const markers = { '发送指令': 40, '在线时间': 300, '击败巨人': 4, '击败巨人王': 2 };
    const { service } = createService({ titles: '[]' }, markers, { allTitles });

    const out = await service.viewAvailableTitles(42);

    // 三个不同系列各只有一个阶位，全部展开，编号连续
    expect(out).toContain('1、肝帝II');
    expect(out).toContain('发送指令(40/100)');
    expect(out).toContain('2、住这了I');
    expect(out).toContain('在线时间(5分0秒/1小时0分)');
    expect(out).toContain('3、巨人猎手I');
    // "*巨人" 模糊匹配：击败巨人(4)+击败巨人王(2)=6
    expect(out).toContain('*巨人(6/10)');
  });

  it('全部已领取时提示无可领取，不注册临时输入', async () => {
    const allTitles = [
      { name: '肝帝I', requirements: [{ name: '发送指令', quantity: 10 }], rewards: [] },
    ];
    const { service, shortcutService } = createService(
      { titles: [{ name: '肝帝I', equipped: false }] },
      {},
      { allTitles },
    );

    const out = await service.viewAvailableTitles(42);

    expect(out).toContain('所有称号均已领取');
    expect(shortcutService.setTempInput).not.toHaveBeenCalled();
  });

  it('可领取项置顶成独立区块：顶部点名 + 行首 ✅ + 编号优先发放', async () => {
    const allTitles = [
      { name: '肝帝I', requirements: [{ name: '发送指令', quantity: 10 }], rewards: [] },
      { name: '战神I', requirements: [{ name: '战斗力', quantity: 10000 }], rewards: [] },
    ];
    const { service, shortcutService } = createService(
      { titles: '[]' },
      { '发送指令': 3, '战斗力': 20000 },
      { allTitles },
    );

    const out = await service.viewAvailableTitles(42);

    // 顶部直接点名可领取的称号（只报数量看不出是哪几个）
    expect(out).toContain('✅ 1 个条件已达成可领取：战神I');
    // 已达成的「战神I」置顶成 ✅ 区块并拿到 1 号；未达成的「肝帝I」在下一阶区块拿 2 号
    expect(out).toContain('✅ 现在就能领');
    expect(out.indexOf('✅ 1、战神I')).toBeGreaterThan(-1);
    expect(out.indexOf('✅ 1、战神I')).toBeLessThan(out.indexOf(' 2、肝帝I'));
    expect(shortcutService.setTempInput).toHaveBeenCalledWith(
      42,
      ['1@领取称号 战神I', '2@领取称号 肝帝I'].join('#'),
    );
  });

  it('顶部点名超过配置上限时折算「…（共 N 个）」，完整清单仍在编号区块', async () => {
    const allTitles = Array.from({ length: 10 }, (_, i) => ({
      name: `成就王${i + 1}I`,
      requirements: [{ name: '发送指令', quantity: 1 }],
      rewards: [],
    }));
    const { service, shortcutService } = createService(
      { titles: '[]' },
      { '发送指令': 5 },
      { allTitles },
    );

    const out = await service.viewAvailableTitles(42);

    // 默认上限 8（GlobalConfig.titlesView.readySummaryNameLimit）：点名前 8 个 + 折算总数
    expect(out).toContain('✅ 10 个条件已达成可领取：');
    expect(out).toContain('…（共 10 个）');
    // 编号区块完整列出 10 个可领取项，编号 1~10 连续（领奖入口一个都不少）
    expect(out).toContain('✅ 1、成就王1I');
    expect(out).toContain('✅ 10、成就王10I');
    const registered = shortcutService.setTempInput.mock.calls[0][1] as string;
    expect(registered.split('#')).toHaveLength(10);
  });

  it('暂无达成项时不出现「现在就能领」区块，仅展示下一阶进度', async () => {
    const allTitles = [
      { name: '肝帝I', requirements: [{ name: '发送指令', quantity: 10 }], rewards: [] },
    ];
    const { service } = createService({ titles: '[]' }, { '发送指令': 1 }, { allTitles });

    const out = await service.viewAvailableTitles(42);

    expect(out).not.toContain('现在就能领');
    expect(out).toContain('暂无条件达成的称号');
    expect(out).toContain('⏳ 下一阶进度');
    expect(out).toContain(' 1、肝帝I');
  });
});

describe('领取称号（对齐原版）', () => {
  it('原版称号：条件不足播报差距，不发奖励不写入称号', async () => {
    const titlesJson = {
      name: '肝帝II',
      requirements: [{ name: '发送指令', quantity: 100 }],
      rewards: [{ name: '经验胶囊', quantity: 100 }],
    };
    const player: any = { name: '路人甲', titles: '[]', backpack: [] };
    const { service, playerService } = createService(player, { '发送指令': 40 }, {
      getTitleByName: (n: string) => (n === '肝帝II' ? titlesJson : undefined),
    });

    const out = await service.claimTitle(42, '肝帝II');

    // 原版文案：X需要要求x数值,你只达到了当前值
    expect(out).toContain('肝帝II需要发送指令x100,你只达到了40');
    expect(playerService.savePlayer).not.toHaveBeenCalled();
    expect(player.titles).toEqual('[]');
  });

  it('原版称号：条件满足发奖励物品进背包并写入称号', async () => {
    const titlesJson = {
      name: '肝帝I',
      requirements: [{ name: '发送指令', quantity: 10 }],
      rewards: [
        { name: '经验胶囊', quantity: 10 },
        { name: '水晶', quantity: 100 },
        { name: '发带', quantity: 1 },
      ],
    };
    const player: any = { name: '路人甲', titles: '[]', backpack: [] };
    const { service, playerService, taskService, highlight } = createService(player, { '发送指令': 12 }, {
      getTitleByName: (n: string) => (n === '肝帝I' ? titlesJson : undefined),
    });

    const out = await service.claimTitle(42, '肝帝I');

    expect(out).toContain('路人甲领取了称号肝帝I');
    expect(out).toContain('得到了经验胶囊x10、水晶x100、发带x1');
    // 称号写入（对象形状）
    expect(player.titles).toEqual([{ name: '肝帝I', equipped: false }]);
    // 奖励进背包：同名合并数量
    const backpack = player.backpack;
    expect(backpack.find((i: any) => i.name === '经验胶囊')?.quantity).toBe(10);
    expect(backpack.find((i: any) => i.name === '水晶')?.quantity).toBe(100);
    expect(backpack.find((i: any) => i.name === '发带')?.quantity).toBe(1);
    expect(playerService.savePlayer).toHaveBeenCalledTimes(1);
    // 原版 添加成就("领取称号",1,,任务)
    expect(taskService.advance).toHaveBeenCalledWith(42, '领取称号', 1);
    // 高光在落库后推送
    expect(highlight.emit).toHaveBeenCalledWith(42, expect.objectContaining({ type: 'title', names: ['肝帝I'] }));
  });

  it('已拥有的称号（含历史字符串形状）不能重复领取', async () => {
    const player: any = { name: '路人甲', titles: ['肝帝I'], backpack: [] };
    const { service } = createService(player, { '发送指令': 999 }, {
      getTitleByName: () => ({ name: '肝帝I', requirements: [], rewards: [] }),
    });

    const out = await service.claimTitle(42, '肝帝I');

    expect(out).toBe('你已经获得过这个称号了。');
  });

  it('不存在的称号按原版文案提示', async () => {
    const player: any = { name: '路人甲', titles: '[]', backpack: [] };
    const { service } = createService(player, {}, { getTitleByName: () => undefined });

    const out = await service.claimTitle(42, '不存在称号');

    expect(out).toBe('路人甲不存在称号在称号列表不存在！');
  });
});
