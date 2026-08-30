import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { BONUS_CODE_MAP } from '../src/modules/game/item.service';

/**
 * 冥鱼六道轮回（使魔技能.ecode L667-L1306）单元测试
 * 覆盖：帮助文本、非冥鱼门禁、洗装主流程、腿环品质条数、
 * 冥鱼腿环属性锁定（攻击属性名）、六道轮回选择、超次扣资源。
 */
describe('冥鱼六道轮回洗装（使魔技能.ecode L667-L1306）', () => {
  function makeFixture(overrides: any = {}) {
    const player = {
      id: 1,
      name: '冥鱼玩家',
      type: '冥鱼',
      specialSeq: 9,
      mapId: 1,
      currentWeapon: 0,
      // 背包第1件：精良(c) 动力头盔，带 攻击300 与特效5
      backpack: JSON.stringify([
        { name: '动力头盔', type: '装备', quantity: 1, durability: 0, data: 'c!ai300!bx5' },
        { name: '木头', type: '资源', quantity: 10 },
      ]),
      // 默认无腿环
      equipment: JSON.stringify([]),
      weapons: '[]',
      markers: JSON.stringify({}),
      markers2: '[]',
      buffs: '[]',
      sets: '{}',
      ...overrides,
    };
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: JSON.parse(player.markers),
        markers2: [],
        equipment: JSON.parse(player.equipment),
        weapons: [],
        buffs: [],
        backpack: JSON.parse(player.backpack),
        tasks: [],
        safeBox: [],
      })),
      safeJsonParse: jest.fn((value: any, fallback: any) => {
        if (value === undefined || value === null) return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return fallback; }
      }),
      getMarkerValue: jest.fn((source: any, key: string) => Number(source?.[key] || 0)),
      getSkillLevel: jest.fn(() => 1),
      savePlayer: jest.fn(async () => undefined),
      getBackpackItems: jest.fn((p: any) => JSON.parse(p.backpack)),
      enqueueUserWrite: jest.fn((userId: number, fn: () => Promise<any>) => fn()),
    };
    // 最小化复刻 ItemService 的数据串编解码（直接复用真实 BONUS_CODE_MAP，保证全键覆盖）
    const BONUS_CODE_REVERSE: Record<string, string> = {};
    for (const [code, key] of Object.entries(BONUS_CODE_MAP)) BONUS_CODE_REVERSE[key] = code;
    const itemService: any = {
      parseEquipment: jest.fn((item: any) => {
        const eq: any = {
          name: item?.name ?? '', type: '', specialSeq: 0, specialEffect: 0, maker: '',
          bonus: {} as Record<string, number>, baseBonus: {},
          properties: { phys: 0, elec: 0, fire: 0, ice: 0 },
          affixes: ['随机攻击'], attackText: null, buffs: [], negativeType: 0,
          durability: 0, description: '', data: String(item?.data ?? ''),
        };
        const parts = eq.data.split('!');
        for (let i = 1; i < parts.length; i++) {
          const seg = parts[i];
          const code = seg.slice(0, 2);
          const val = parseFloat(seg.slice(2));
          if (code === 'bx') eq.specialEffect = parseInt(String(val), 10) || 0;
          else if (code === '@@') eq.maker = seg.slice(2);
          else if (BONUS_CODE_MAP[code]) eq.bonus[BONUS_CODE_MAP[code]] = val;
        }
        return eq;
      }),
      bonusToDataString: jest.fn((bonus: Record<string, number>) => {
        let out = '';
        for (const [key, value] of Object.entries(bonus)) {
          if (value !== 0 && BONUS_CODE_REVERSE[key]) out += `!${BONUS_CODE_REVERSE[key]}${value}`;
        }
        return out;
      }),
    };
    const itemSystem: any = {
      resourceRequirement: jest.fn(() => ({ success: true, text: '' })),
      rollAffix: jest.fn((bonus: Record<string, number>, affix: string) => {
        const key = ItemSystemService.AFFIX_TO_BONUS[affix];
        if (key) bonus[key] = 42;
      }),
    };
    const service = new FamiliarSkillsService(
      {} as any,
      playerService,
      {} as any,
      {} as any, // combatSystem
      itemService,
      itemSystem,
      {} as any, // mapService
      {} as any, // familiarSystem
      {} as any, // systemConfig
      {} as any, // staticData
      {} as any, // taskService
      {} as any, // mutateService
    );
    return { service, player, playerService, itemSystem };
  };

  it('空参数返回原版帮助文本', async () => {
    const { service } = makeFixture();
    await expect(service.sixPaths(1)).resolves.toContain('“六道轮回1攻击”');
  });

  it('非冥鱼无法使用', async () => {
    const { service } = makeFixture({ type: '兰音', specialSeq: 23 });
    await expect(service.sixPaths(1, '1攻击')).resolves.toBe('需要冥鱼才能使出六道轮回');
  });

  it('无腿环时刷出5条候选并进入待选状态', async () => {
    const { service, player } = makeFixture();
    const result = await service.sixPaths(1, '1攻击');
    expect(result).toContain('的属性被修改了');
    expect(result).toContain('今天使用了1次');
    // 无腿环固定5条
    expect(result).toMatch(/\n5、/);
    expect(result).not.toMatch(/\n6、/);
    // 待选状态写入 sets
    const sets = JSON.parse(player.sets);
    expect(sets['六道轮回'].backpackIndex).toBe(1);
    expect(sets['六道轮回'].options).toHaveLength(5);
    // 装备数据串：攻击被清掉，转为采集=1 待洗标记，特效保留
    const backpack = JSON.parse(player.backpack);
    expect(backpack[0].data).toContain('!bv1');
    expect(backpack[0].data).not.toContain('!ai');
    expect(backpack[0].data).toContain('!bx5');
    // 计数
    const markers = JSON.parse(player.markers);
    expect(markers['冥鱼次数']).toBe(1);
  });

  it('冥鱼腿环按品质提升条数（b=7条）', async () => {
    const { service } = makeFixture({
      equipment: JSON.stringify([{ name: '蕾丝边腿环', type: '腿环', data: 'b!ai100' }]),
    });
    const result = await service.sixPaths(1, '1攻击');
    expect(result).toMatch(/\n7、/);
    expect(result).not.toMatch(/\n8、/);
  });

  it('传说腿环刷出8条，神迹腿环刷出11条', async () => {
    const s8 = makeFixture({ equipment: JSON.stringify([{ name: '蕾丝边腿环', type: '腿环', data: 's' }]) });
    expect(await s8.service.sixPaths(1, '1攻击')).toMatch(/\n8、/);

    const s11 = makeFixture({ equipment: JSON.stringify([{ name: '蕾丝边腿环', type: '腿环', data: 'x' }]) });
    expect(await s11.service.sixPaths(1, '1攻击')).toMatch(/\n11、/);
  });

  it('先发「攻击闪避」后所有候选项锁定为闪避', async () => {
    const fx = makeFixture({
      markers: JSON.stringify({ 目标: '闪避' }),
    });
    const result = await fx.service.sixPaths(1, '1攻击');
    expect(result).toContain('选择你中意的项目');
    const pending = JSON.parse(fx.player.sets)['六道轮回'];
    expect(pending.options).toHaveLength(5);
    for (const opt of pending.options) {
      expect(opt.name).toBe('闪避');
    }
  });

  it('锁定目标不在候选池时按原版提示', async () => {
    const { service } = makeFixture({
      markers: JSON.stringify({ 目标: '暴击' }), // 随机攻击池里没有暴击
    });
    await expect(service.sixPaths(1, '1攻击')).resolves.toBe('冥鱼玩家这个装备没有暴击这个属性');
  });

  it('装备已存在锁定属性时无法指向', async () => {
    const { service } = makeFixture({
      // 装备同时带 攻击 和 闪避；洗攻击后剩余闪避与目标冲突
      backpack: JSON.stringify([
        { name: '动力头盔', type: '装备', quantity: 1, durability: 0, data: 'c!ai300!ay50' },
      ]),
      markers: JSON.stringify({ 目标: '闪避' }),
    });
    await expect(service.sixPaths(1, '1攻击')).resolves.toBe(
      '冥鱼玩家这个装备已经有闪避的属性，无法指向，请使用“攻击闪避”来指定其他属性',
    );
  });

  it('六道轮回选择把选中属性写回装备并清除待选标记', async () => {
    const fx = makeFixture();
    await fx.service.sixPaths(1, '1攻击');
    const pending = JSON.parse(fx.player.sets)['六道轮回'];
    const pick = pending.options[1]; // 选第2项

    const result = await fx.service.sixPathsChoice(1, '2');
    expect(result).toContain(`得到了${pick.name}`);
    const backpack = JSON.parse(fx.player.backpack);
    // 选中值 42 写入对应编码键，待洗标记 bv 已清除
    expect(backpack[0].data).not.toContain('!bv');
    const chosenKey = ItemSystemService.AFFIX_TO_BONUS[pick.name];
    const KEY_TO_CODE: Record<string, string> = {};
    for (const [code, key] of Object.entries(BONUS_CODE_MAP)) KEY_TO_CODE[key] = code;
    const code = KEY_TO_CODE[chosenKey];
    expect(code).toBeTruthy();
    expect(backpack[0].data).toContain(`!${code}42`);
    // 待选状态清空
    expect(JSON.parse(fx.player.sets)['六道轮回']).toBeUndefined();
  });

  it('无效序号重新展示选项，无待选项时按原版提示', async () => {
    const none = makeFixture();
    await expect(none.service.sixPathsChoice(1, '')).resolves.toBe('冥鱼玩家当前没有可以选择的项目');

    const fx = makeFixture();
    await fx.service.sixPaths(1, '1攻击');
    const again = await fx.service.sixPathsChoice(1, '99');
    expect(again).toContain('选择你中意的项目');
    expect(again).toMatch(/\n5、/);
  });

  it('超免费次数且资源不足时拦截', async () => {
    const fx = makeFixture({
      markers: JSON.stringify({ 冥鱼次数: 999 }),
    });
    fx.itemSystem.resourceRequirement.mockReturnValue({ success: false, text: '\n需要木头x4985，你只有10' });
    const result = await fx.service.sixPaths(1, '1攻击');
    expect(result).toContain('继续使用需要消耗');
    expect(result).toContain('木头');
  });

  it('超免费次数成功洗装后扣除资源', async () => {
    const fx = makeFixture({
      backpack: JSON.stringify([
        { name: '动力头盔', type: '装备', quantity: 1, durability: 0, data: 'c!ai300' },
        { name: '木头', type: '资源', quantity: 99999 },
        { name: '石头', type: '资源', quantity: 99999 },
        { name: '绳子', type: '资源', quantity: 99999 },
        { name: '铁矿', type: '资源', quantity: 99 },
      ]),
      markers: JSON.stringify({ 冥鱼次数: 999 }), // 免费12次 → 超出987 → 木头×4985
    });
    const result = await fx.service.sixPaths(1, '1攻击');
    expect(result).toContain('消耗了');
    const backpack = JSON.parse(fx.player.backpack);
    const wood = backpack.find((it: any) => it.name === '木头');
    // 原版公式 50×(1+超出÷10)：超出987次 → floor(50×99.7)=4985
    expect(wood.quantity).toBe(99999 - 4985);
    const iron = backpack.find((it: any) => it.name === '铁矿');
    expect(iron.quantity).toBe(98);
  });
});
