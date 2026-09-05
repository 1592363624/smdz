import { GameService } from '../src/modules/game/game.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { DelayedTaskService } from '../src/modules/game/delayed-task.service';
import { parseJson } from './parse-json.util';

/**
 * 手动载具开采与补魔语义对齐自检（修复迁移审计发现 1 / 发现 2）：
 * - handleMine 无参 = 原版 _主程序.ecode L7491-7531「开采」（载具开采门禁链 +
 *   工作60秒 + 覅攻击pd引怪 + 开采1c2c 60秒延时结算）
 * - settleManualMine = 原版 L7534-7608「开采1c2c」（16倍产出、跟随因子、次数-6、
 *   枯竭移除+刷新标记）
 * - handleRefill = 原版 L7110-7129「补魔」（躺下+屋内+跟随对象门禁链 + 工作35秒
 *   + 覅b魔w成 30秒延时结算）
 * - completeRefill = 原版 L7158-7319「覅b魔w成」（兴奋增益 + 好感+3 + 补魔任务）
 */

const SECOND_MS = 1000;

function makeFixture(options: {
  vehicleParts?: string[];
  vehicleHp?: number;
  hasVehicle?: boolean;
  isInstance?: boolean;
  actionRestricted?: boolean;
  resources?: any[];
  summons?: any[];
  playerMarkers?: Record<string, any>;
  markers2?: any[];
  mapName?: string;
  houseName?: string;
  specialPets?: number; // hasSpecialPet 返回值（-1=无）
} = {}) {
  const player: any = {
    id: 1,
    userId: 42,
    name: '测试玩家',
    level: 10,
    mapId: 7,
    vehicle: options.hasVehicle === false ? '' : 'v1',
    houseName: options.houseName ?? '',
    hp: 100,
    markers: JSON.stringify(options.playerMarkers || {}),
    markers2: JSON.stringify(options.markers2 || []),
    backpack: '[]',
    buffs: '[]',
  };
  const map: any = {
    id: 7,
    name: options.mapName ?? '测试地图',
    isInstance: options.isInstance ?? false,
    resources: JSON.stringify(options.resources ?? []),
    resources2: '[]',
    markers2: '[]',
    summons: JSON.stringify(options.summons ?? []),
    vehicles: JSON.stringify(options.hasVehicle === false ? [] : [{
      id: 'v1',
      name: '采集车',
      currentHp: options.vehicleHp ?? 100,
      parts: (options.vehicleParts ?? ['激光采集器']).map((name) => ({ name })),
    }]),
  };
  const taskService = {
    advance: jest.fn(async () => ''),
    consumeNotifications: jest.fn(() => ''),
  };
  const prisma = {
    player: {
      findMany: jest.fn(async () => [{ userId: 42 }]),
      findUnique: jest.fn(async () => player),
    },
  };
  // 持久化延时任务真实服务 + 内存桩库：验证排程行 type/runAt
  const delayedTaskRows: any[] = [];
  let delayedTaskNextId = 1;
  const delayedTaskPrisma: any = {
    findMany: jest.fn(async () => delayedTaskRows),
    deleteMany: jest.fn(async ({ where }: any) => {
      const match = (r: any) => {
        if (where.id !== undefined) return r.id === where.id;
        if (where.type !== undefined && r.type !== where.type) return false;
        if (where.userId !== undefined && r.userId !== where.userId) return false;
        if (where.dedupeKey !== undefined && r.deduupeKey !== undefined && r.dedupeKey !== where.dedupeKey) return false;
        return true;
      };
      const idx = delayedTaskRows.findIndex(match);
      if (idx < 0) return { count: 0 };
      delayedTaskRows.splice(idx, 1);
      return { count: 1 };
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: delayedTaskNextId++, ...data };
      delayedTaskRows.push(row);
      return row;
    }),
  };
  const delayedTaskService = new DelayedTaskService({ delayedTask: delayedTaskPrisma } as any);
  const playerService = {
    enqueueUserWrite: jest.fn((userId: number, fn: () => any) => fn()),
    getPlayerData: jest.fn(async () => ({
      player,
      weapons: [],
      markers: parseJson(player.markers, {}),
      markers2: parseJson(player.markers2, []),
    })),
    safeJsonParse: jest.fn((value: any, fallback: any) => {
      if (value === null || value === undefined) return fallback;
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
    }),
    getBackpackItems: jest.fn((currentPlayer: any) => {
      try { return parseJson(currentPlayer.backpack, []); } catch { return []; }
    }),
    savePlayer: jest.fn(async () => undefined),
    addExp: jest.fn(async () => ({ leveledUp: false, newLevel: 10 })),
    isPlayerDead: jest.fn((p: any) => Number(p?.hp ?? 1) <= 0),
    getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
    handlePlayerDeath: jest.fn(async () => '死了'),
  };
  const combatSystem: any = {
    buildAttackerBonus: jest.fn(() => ({ 采集: 100 })),
    actionUnrestricted: jest.fn(() => options.actionRestricted
      ? { restricted: true, text: '测试玩家 移动中，还需要 3 秒' }
      : { restricted: false, text: '' }),
    triggerMapBattleLoop: jest.fn(async () => undefined),
  };
  const chatService = {
    broadcastSystem: jest.fn(async (_channel: string, _text: string, _userId?: number) => undefined),
    emitToUser: jest.fn(async (_userId: number, _text: string) => undefined),
  };
  const combatState = new CombatStateService();
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    delayedTaskService,
    playerService,
    mapService: {
      getMapById: jest.fn(async () => map),
      updateDynamicFields: jest.fn(async () => undefined),
      mutateMapFields: jest.fn(async (_mapId: number, fields: string[], mutator: (f: any) => any) => {
        const f: any = {};
        for (const field of fields) {
          const raw = (map as any)[field];
          f[field] = typeof raw === 'string'
            ? (() => { try { return JSON.parse(raw); } catch { return field === 'markers' ? {} : []; } })()
            : raw;
        }
        const result = mutator(f);
        for (const field of fields) (map as any)[field] = f[field];
        return result ?? {};
      }),
      mutateSummons: jest.fn(async (_mapId: number, mutator: (summons: any[]) => any) => {
        const summons = parseJson(map.summons, []);
        const result = mutator(summons);
        map.summons = summons;
        return result;
      }),
    },
    combatSystem,
    combatState,
    staticData: {
      getEquipmentByName: jest.fn(() => undefined),
      getDialogue: jest.fn((_playerName: string, _object: any, _objectName: string, type: number) => `对话${type}`),
    },
    itemSystemService: {
      generateRewardEquipment: jest.fn(async (name: string, quality?: string) => ({
        name, quality, type: '装备', data: 'e!bx0',
      })),
    },
    taskService,
    chatService,
    homeService: { hasSpecialPet: jest.fn(() => options.specialPets ?? -1) },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    pushPlayerUpdate: jest.fn(async () => undefined),
    pushMapUpdate: jest.fn(async () => undefined),
  });
  return {
    service, player, map, taskService, prisma, chatService, playerService,
    combatSystem, delayedTaskService, delayedTaskRows, shortcutService: (service as any).shortcutService,
  };
}

describe('手动载具开采（原版 L7491「开采」）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('无载具 → 需要驾驶载具', async () => {
    const fixture = makeFixture({ hasVehicle: false });
    const result = await fixture.service.handleMine(42);
    expect(result).toContain('需要驾驶载具');
  });

  it('载具生命为0 → 载具需要维修', async () => {
    const fixture = makeFixture({ vehicleHp: 0 });
    const result = await fixture.service.handleMine(42);
    expect(result).toContain('载具需要“维修”');
  });

  it('无采集器部件 → 提示安装并注册「1@制造部件」临时输入替换', async () => {
    const fixture = makeFixture({ vehicleParts: [] });
    const result = await fixture.service.handleMine(42);
    expect(result).toContain('需要安装激光采集器、行星解裂器或者引力调频器');
    expect(fixture.shortcutService.setTempInput).toHaveBeenCalledWith(42, '1@制造部件');
  });

  it('副本地图 → 不能在副本里干这个', async () => {
    const fixture = makeFixture({ isInstance: true });
    const result = await fixture.service.handleMine(42);
    expect(result).toContain('不能在副本里干这个');
  });

  it('行动受限 → 返回限制文本（躺下豁免由 actionUnrestricted 处理）', async () => {
    const fixture = makeFixture({ actionRestricted: true });
    const result = await fixture.service.handleMine(42);
    expect(result).toContain('还需要 3 秒');
  });

  it('通过门禁 → 工作60秒 + 排程60秒延时 + 引怪 + 文本含采集器与地图名', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const fixture = makeFixture({ summons: [{ name: '小雫', ownerQQ: '42', hp: 100, markers: { '跟随': 0 } }] });
      const result = await fixture.service.handleMine(42);

      // 文本（原版 L7519-7526）
      expect(result).toContain('测试玩家');
      expect(result).toContain('带着小雫一起');
      expect(result).toContain('用激光采集器轰炸测试地图');

      // 工作 60 秒标记（原版 L7518）
      const markers2 = parseJson(fixture.player.markers2, []);
      const work = markers2.find((m: any) => (m.name ?? m.名称) === '工作');
      expect(work).toBeTruthy();

      // 排程 mine 延时（原版 L7531 开采1c2c 60秒）
      const row = fixture.delayedTaskRows.find((r: any) => r.type === 'mine');
      expect(row).toBeTruthy();
      expect(row.userId).toBe(42);
      expect(row.runAt.getTime()).toBeGreaterThanOrEqual(1_700_000_000_000 + 59 * SECOND_MS);
      expect(row.runAt.getTime()).toBeLessThanOrEqual(1_700_000_000_000 + 61 * SECOND_MS);

      // 无隐形模块 → 引怪（原版 L7527-7529 覅攻击pd 5秒）
      expect(fixture.combatSystem.triggerMapBattleLoop).toHaveBeenCalledWith(42, 5, expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('有隐形模块 → 不引怪，仅刷新玩家战斗标记', async () => {
    const fixture = makeFixture({ vehicleParts: ['激光采集器', '隐形模块'] });
    await fixture.service.handleMine(42);
    expect(fixture.combatSystem.triggerMapBattleLoop).not.toHaveBeenCalled();
    const markers2 = parseJson(fixture.player.markers2, []);
    expect(markers2.some((m: any) => (m.name ?? m.名称) === '战斗')).toBe(true);
  });
});

describe('载具开采结算（原版 L7534「开采1c2c」）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('按 16 倍公式产出并扣减资源次数', async () => {
    const fixture = makeFixture({
      vehicleParts: ['激光采集器'],
      summons: [{ name: '小雫', ownerQQ: '42', hp: 100, markers: { '跟随': 0 } },
                { name: '小凰', ownerQQ: '42', hp: 100, markers: { '跟随': 0 } }],
      resources: [{
        name: '矿脉', marker: '', times: 100, renewable: true,
        outputs: [{ name: '铁矿', count: 2, chance: 100 }, { name: '电力', count: 5, chance: 100 }],
      }],
    });
    await fixture.service.settleManualMine(42);

    // 2使魔 → min(2,3)+1=3 因子；2×16×(1+100/100)×3次roll(100%)=192；电力跳过
    const text = fixture.chatService.broadcastSystem.mock.calls[0][1] as string;
    expect(text).toContain('用激光采集器开采出了');
    expect(text).toContain('铁矿×192');

    // 次数 100-6=94（原版 L7572）
    const resources = parseJson(fixture.map.resources, []);
    expect(resources[0].times).toBe(94);

    // 成就/任务（原版 L7549/L7602-7605）
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '开采');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集资源', 192);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集铁矿', 192);

    // 背包写入
    const backpack = parseJson(fixture.player.backpack, []);
    const iron = backpack.find((item: any) => item.name === '铁矿');
    expect(Number(iron?.quantity ?? iron?.count ?? 0)).toBeCloseTo(192, 6);
  });

  it('行星解裂器产出额外随机增幅（1.25~1.5 倍）', async () => {
    const fixture = makeFixture({
      vehicleParts: ['行星解裂器'],
      resources: [{
        name: '矿脉', marker: '', times: -1, renewable: true,
        outputs: [{ name: '铁矿', count: 1, chance: 100 }],
      }],
    });
    await fixture.service.settleManualMine(42);

    // 无使魔 → factor 1；1×16×2×(1.25~1.5) = 40~48
    const text = fixture.chatService.broadcastSystem.mock.calls[0][1] as string;
    const match = text.match(/铁矿×([\d.]+)/)!;
    const amount = Number(match[1]);
    expect(amount).toBeGreaterThanOrEqual(40);
    expect(amount).toBeLessThanOrEqual(48);
  });

  it('次数归零 → 资源移除并挂1800秒刷新标记', async () => {
    const fixture = makeFixture({
      resources: [{
        name: '矿脉', marker: '', times: 6, renewable: true,
        outputs: [{ name: '铁矿', count: 1, chance: 100 }],
      }],
    });
    await fixture.service.settleManualMine(42);

    const resources = parseJson(fixture.map.resources, []);
    expect(resources).toHaveLength(0);
    const markers2 = parseJson(fixture.map.markers2, []);
    const refresh = markers2.find((m: any) => (m.name ?? m.名称) === '刷新资源矿脉');
    expect(refresh).toBeTruthy();
    expect(refresh.expireAt - Date.now()).toBeLessThanOrEqual(1800 * SECOND_MS);
  });

  it('无产出 → 回复资源枯竭文本', async () => {
    const fixture = makeFixture({
      resources: [{
        name: '枯矿', marker: '', times: -1, renewable: true,
        outputs: [{ name: '铁矿', count: 1, chance: 0 }],
      }],
    });
    await fixture.service.settleManualMine(42);
    const text = fixture.chatService.broadcastSystem.mock.calls[0][1] as string;
    expect(text).toContain('测试地图的资源已经枯竭了');
  });

  it('不可再生/一次性/产出2资源不参与载具开采结算', async () => {
    const fixture = makeFixture({
      resources: [
        { name: '非再生矿', marker: '', times: -1, renewable: false, outputs: [{ name: '铁矿', count: 1, chance: 100 }] },
        { name: '一次性宝箱', marker: '宝箱', times: -1, renewable: true, outputs: [{ name: '铁矿', count: 1, chance: 100 }] },
        { name: '作物田', marker: '', times: -1, renewable: true, outputs: [], outputs2: [{ name: '小麦', count: 1, chance: 100 }] },
      ],
    });
    await fixture.service.settleManualMine(42);
    const text = fixture.chatService.broadcastSystem.mock.calls[0][1] as string;
    expect(text).toContain('资源已经枯竭了');
    const resources = parseJson(fixture.map.resources, []);
    expect(resources).toHaveLength(3); // 三个资源均未被扣次数/移除
  });
});

describe('补魔门禁链（原版 L7110「补魔」）', () => {
  const homeMap = (overrides: Record<string, any> = {}) => ({
    mapName: '测试玩家屋内',
    houseName: '测试玩家',
    summons: [{ name: '小雫', ownerQQ: '42', hp: 100, markers: { '跟随': 0 } }],
    playerMarkers: { '躺下': 1 },
    ...overrides,
  });

  afterEach(() => jest.restoreAllMocks());

  it('未躺下 → 需要“躺下”', async () => {
    const fixture = makeFixture(homeMap({ playerMarkers: {} }));
    const result = await fixture.service.handleRefill(42);
    expect(result).toContain('需要“躺下”');
  });

  it('不在自家屋内 → 不能野战', async () => {
    const fixture = makeFixture(homeMap({ mapName: '荒野' }));
    const result = await fixture.service.handleRefill(42);
    expect(result).toContain('不能野战');
  });

  it('无跟随召唤物 → 不能自己发电', async () => {
    const fixture = makeFixture(homeMap({
      summons: [{ name: '小雫', ownerQQ: '42', hp: 100, markers: { '跟随': 1 } }],
    }));
    const result = await fixture.service.handleRefill(42);
    expect(result).toContain('不能自己发电');
  });

  it('补魔间隔冷却中 → 太频繁了', async () => {
    const fixture = makeFixture(homeMap({
      markers2: [{ name: '补魔间隔', expireAt: Date.now() + 3600 * SECOND_MS }],
    }));
    const result = await fixture.service.handleRefill(42);
    expect(result).toContain('太频繁了');
  });

  it('通过门禁 → 工作35秒 + 排程30秒延时 + 补魔开始文本', async () => {
    const fixture = makeFixture(homeMap());
    const result = await fixture.service.handleRefill(42);

    expect(result).toContain('正在和小雫一起补魔');
    expect(result).toContain('对话7'); // 取对话(…,7) 补魔开始台词

    const markers2 = parseJson(fixture.player.markers2, []);
    const work = markers2.find((m: any) => (m.name ?? m.名称) === '工作');
    expect(work).toBeTruthy();
    const cooldown = markers2.find((m: any) => (m.name ?? m.名称) === '补魔间隔');
    expect(cooldown).toBeTruthy();

    const row = fixture.delayedTaskRows.find((r: any) => r.type === 'refill');
    expect(row).toBeTruthy();
    expect(row.userId).toBe(42);
    expect(row.runAt.getTime() - Date.now()).toBeLessThanOrEqual(31 * SECOND_MS);
  });
});

describe('补魔结算（原版 L7158「覅b魔w成」）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('玩家与跟随召唤物获得兴奋增益，好感+3，补魔任务+2', async () => {
    const fixture = makeFixture({
      mapName: '测试玩家屋内',
      houseName: '测试玩家',
      summons: [
        { name: '小雫', ownerQQ: '42', hp: 100, markers: { '跟随': 0 }, buffs: [] },
        { name: '露娜', qq: '怪物露娜1g', ownerQQ: '42', hp: 100, markers: { '跟随': 0 }, buffs: [] },
      ],
    });
    await fixture.service.completeRefill(42);

    // 玩家「兴奋」600秒（无小恶魔在场，原版 L7169-7183）
    const playerBuffs = parseJson(fixture.player.buffs, []);
    const excitement = playerBuffs.find((b: any) => (b.name ?? b.名称) === '兴奋');
    expect(excitement).toBeTruthy();
    expect(excitement.有效期至 - Date.now()).toBeLessThanOrEqual(600 * SECOND_MS);

    // 露娜在跟随显示名单中出现（原版 召唤物跟随显示 不排除露娜），
    // 但增益/好感名单被排除（原版 L7190-7192：露娜是来帮忙的不是来上床的）
    const text = fixture.chatService.broadcastSystem.mock.calls[0][1] as string;
    expect(text).toContain('补魔结束');
    expect(text).toContain('测试玩家、小雫10分钟内攻击+15%'); // 增益名单只有小雫
    expect(text).toContain('小雫对测试玩家好感+3');

    // 召唤物增益+好感（原版 L7210-7211）
    const summons = parseJson(fixture.map.summons, []);
    const xiaona = summons.find((s: any) => s.name === '小雫');
    expect(parseJson(xiaona.buffs, []).some((b: any) => (b.name ?? b.名称) === '兴奋')).toBe(true);
    expect(Number(xiaona.markers['好感42'] ?? 0)).toBe(3);

    // 补魔任务+2（原版 L7318 添加成就("补魔", c)）
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '补魔', 2);
  });

  it('小恶魔在场 → 兴奋时长延长到3600秒', async () => {
    const fixture = makeFixture({
      mapName: '测试玩家屋内',
      houseName: '测试玩家',
      specialPets: 3, // hasSpecialPet 命中下标
      summons: [{ name: '小恶魔', ownerQQ: '42', hp: 100, markers: { '跟随': 0 }, buffs: [] }],
    });
    await fixture.service.completeRefill(42);
    const playerBuffs = parseJson(fixture.player.buffs, []);
    const excitement = playerBuffs.find((b: any) => (b.name ?? b.名称) === '兴奋');
    const remainSec = (excitement.有效期至 - Date.now()) / SECOND_MS;
    expect(remainSec).toBeGreaterThan(3590);
    expect(remainSec).toBeLessThanOrEqual(3600);
  });

  it('补魔对象全部丢失 → 补魔失败', async () => {
    const fixture = makeFixture({
      summons: [{ name: '小雫', ownerQQ: '42', hp: 100, markers: { '跟随': 1 } }],
    });
    await fixture.service.completeRefill(42);
    const text = fixture.chatService.broadcastSystem.mock.calls[0][1] as string;
    expect(text).toContain('补魔对象丢失，补魔失败');
  });
});
