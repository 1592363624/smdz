/**
 * 「信息」指令装备栏取数口径回归测试
 * 复刻 src: 显示数据.ecode 使魔数据 L2032-2210 + 物品操作.ecode 寻找装备 L1824
 *
 * 历史问题：装备生成时 item.type 固定为 '装备'（大分类），不写槽位名。
 * 旧实现 handleInfo 用 `e.type === slotName` 永远匹配不到 → 所有装备栏位都显示"无"，
 * 而网页左面板 buildEquipmentSnapshot 用 staticData.getEquipmentByName 查 equipType → 正常显示，
 * 表现为同一玩家"UI 面板"和"信息"指令装备信息不一致。
 *
 * 修复：handleInfo 改用与 buildEquipmentSnapshot 一致的 getEquipType 静态表查 equipType 口径，
 * 确保「信息」文本面板的装备栏与左面板保持一致（原版 寻找装备 等价于 z=装备列表[b] 后取 z.类型）。
 */
import { GameService } from '../src/modules/game/game.service';

describe('信息 指令 装备栏取数 (数据显示.ecode 使魔数据 L2032-2210)', () => {
  /**
   * 构造 GameService：mock 仅保留 handleInfo 用到的依赖
   * (playerService / mapService / bonusService / combatSystem / combatState / taskService / staticData)
   */
  function makeService(opts: {
    staticDataGetEquipmentByName: (name: string) => any;
  }) {
    const equipment = [
      // 玩家身上穿的 6 件：item.type 都是 '装备'，槽位名在静态表 equipType
      { name: '防弹头盔', type: '装备', data: 'b' },
      { name: '动力肩甲', type: '装备', data: 'a' },
      { name: '防弹上衣', type: '装备', data: 'c' },
      { name: '游侠腰带', type: '装备', data: 'd' },
      { name: '游侠披风', type: '装备', data: 'a' },
      { name: '游骑兵头盔', type: '装备', data: 'e' },
    ];
    const player = {
      name: '测试者',
      level: 8,
      exp: 100,
      hp: 50,
      maxHp: 67,
      shield: 2,
      maxShield: 37,
      armor: 2,
      maxArmor: 47,
      attack: 14,
      defense: 29,
      speed: 22,
      crit: 3,
      dodge: 0,
      hit: 0,
      mapId: 1,
      equipment: JSON.stringify(equipment),
      weapons: JSON.stringify([]),
      currentWeapon: 0,
      markers: JSON.stringify({}),
      tasks: JSON.stringify([]),
    };
    const service = Object.create(GameService.prototype) as any;
    service.playerService = {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: {},
        buffs: [],
        weapons: [],
        equipment,
        sets: {},
      })),
      safeJsonParse: <T>(value: string, fallback: T): T => {
        try { return JSON.parse(value) as T; } catch { return fallback; }
      },
      calcUpgradeExp: jest.fn(() => 69),
    };
    service.mapService = {
      getMapById: jest.fn(async () => ({ name: '医疗室' })),
    };
    service.bonusService = {
      calcCombatPower: jest.fn(() => 452.03),
    };
    service.combatSystem = {
      buildAttackerBonus: jest.fn(() => ({
        攻击: 14, 生命: 67, 装甲: 47, 速度: 22, 护盾: 37,
      })),
    };
    service.combatState = {
      getAchievementProficiency: jest.fn(() => 0),
    };
    service.taskService = {
      ensureTutorialTasks: jest.fn(async () => {}),
    };
    service.staticData = {
      getEquipmentByName: jest.fn(opts.staticDataGetEquipmentByName),
    };
    service.shortcutService = { setTempInput: jest.fn(async () => {}) };
    return service;
  }

  // 静态表槽位映射（模拟 equipments.json equipType）
  const slotMap: Record<string, string> = {
    防弹头盔: '头部',
    动力肩甲: '肩膀',
    防弹上衣: '上身',
    游侠腰带: '腰部',
    游侠披风: '背部',
    游骑兵头盔: '头部', // 故意造一个同名多槽位的回归场景
  };

  it('用静态表 equipType 取数：6 件装备按槽位显示在「信息」文本面板', async () => {
    const service = makeService({
      staticDataGetEquipmentByName: (name: string) => ({
        equipType: slotMap[name],
      }),
    });
    const out = await service.handleInfo(42);

    // 至少应展示装备栏
    expect(out).toContain('📋 装备:');
    // 6 件都能找到对应槽位（与左面板 buildEquipmentSnapshot 同口径）
    expect(out).toContain('头部: 精良 防弹头盔');
    expect(out).toContain('肩膀: 史诗 动力肩甲');
    expect(out).toContain('上身: 优秀 防弹上衣');
    expect(out).toContain('腰部: 良好 游侠腰带');
    expect(out).toContain('背部: 史诗 游侠披风');
  });

  it('同槽位多件只显示第一件（findIndex 行为）', async () => {
    const service = makeService({
      staticDataGetEquipmentByName: (name: string) => ({
        equipType: slotMap[name],
      }),
    });
    const out = await service.handleInfo(42);
    // "头部" 应该只命中第一个找到的 防弹头盔
    const headLines = out.split('\n').filter((l) => l.startsWith('  头部:'));
    expect(headLines.length).toBe(1);
    expect(headLines[0]).toContain('防弹头盔');
  });

  it('空槽位回退为「无(+0)」，与原版 数据显示.ecode L2048/2068 等保持一致', async () => {
    const service = makeService({
      staticDataGetEquipmentByName: (name: string) => ({
        equipType: slotMap[name],
      }),
    });
    const out = await service.handleInfo(42);
    // 饰品/手臂/手掌/下身/腿环/腿部/脚部 都没穿 → 全部回退
    expect(out).toContain('饰品: 无(+0)');
    expect(out).toContain('手臂: 无(+0)');
    expect(out).toContain('手掌: 无(+0)');
    expect(out).toContain('下身: 无(+0)');
    expect(out).toContain('腿环: 无(+0)');
    expect(out).toContain('腿部: 无(+0)');
    expect(out).toContain('脚部: 无(+0)');
  });

  it('无武器时 武器 槽位回退为「普通 拳头(+0)」', async () => {
    const service = makeService({
      staticDataGetEquipmentByName: (name: string) => ({
        equipType: slotMap[name],
      }),
    });
    const out = await service.handleInfo(42);
    expect(out).toContain('武器: 普通 拳头(+0)');
  });

  it('静态表查不到时（未收录的旧装备）回退到 item.type，避免整段崩溃', async () => {
    const service = makeService({
      staticDataGetEquipmentByName: () => null, // 模拟静态表里没有
    });
    // 走 fallback 路径：getEquipType 会返回 item.type 即 '装备'，依旧不匹配任何 slotName
    // 整个装备栏都应回退为"无"，但不应抛错
    const out = await service.handleInfo(42);
    expect(out).toContain('📋 装备:');
    expect(out).toContain('头部: 无(+0)');
    expect(out).toContain('武器: 普通 拳头(+0)');
  });
});
