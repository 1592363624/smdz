/**
 * Issue #11 回归测试：探测雷达升级无效 / 扫荡计数断链 / 背包同名物品不合并。
 *
 * 对应原版：
 *  - 使魔大战.txt L13957-L13969（[升级探测雷达一/二] 标记=探测雷达等级N）
 *  - _主程序.ecode L3013-L3274（探测雷达十类目标扫描，含废弃载具）
 *  - _主程序.ecode L9314-L9315（击杀添加成就 击败怪物/击败X → 扫荡需求读取）
 *  - 数据显示.ecode L3792（扫荡需求 取成就熟练度(玩家.成就, "击败"+怪物名)）
 *  - 后台运作.ecode L1390-L1411（生成随机载具：全图有无主载具时 10/22 点不必刷）
 */
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { GameService } from '../src/modules/game/game.service';
import { GatherPanelService } from '../src/modules/game/commands/gather-panel.service';

/** ItemSystemService 手工构造桩（绕过 Nest DI） */
function makeItemSystem(staticOverrides: Partial<Record<string, any>> = {}) {
  const staticData: any = {
    getAllCraftings: () => [
      {
        name: '升级探测雷达一',
        noCraft: false,
        level: 1,
        outputs: [{ name: '经验胶囊', count: 100 }],
        requirements: [{ name: '木头', count: 500 }],
        gainMarkers: ['探测雷达等级1'],
      },
    ],
    getItemByName: (n: string) => (n === '经验胶囊' ? { name: '经验胶囊', type: '物品' } : null),
    getEquipmentByName: () => null,
    ...staticOverrides,
  };
  const markers: Record<string, number> = {};
  const playerData: any = {
    player: { name: '测试员', level: 10, markers, sets: {} },
    backpack: [{ name: '木头', type: '资源', quantity: 1000, count: 1000 }],
    markers,
  };
  const playerService: any = {
    getPlayerData: async () => playerData,
    savePlayer: async () => undefined,
    deathGateText: async () => null, // 未死放行（死亡门禁同源，桩场景恒放行）
    enqueueUserWrite: async (_userId: number, fn: () => Promise<any>) => fn(),
    safeJsonParse: (v: any) => {
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return []; }
    },
  };
  const achievementService: any = {
    setAchievement: (m: any, k: string, v: number) => { m[k] = v; },
    checkTitles: async () => undefined,
  };
  const service = new (ItemSystemService as any)(
    {} /* prisma */, playerService, {} /* bonus */, {} /* itemService */,
    achievementService, staticData,
  );
  (service as any).gatherPanelServiceSvc?.attachFacade?.(service);
  return { service, playerData, markers };
}

describe('Issue #11：制造升级探测雷达写入等级标记', () => {
  it('craftItem 制造「升级探测雷达一」后 markers[探测雷达等级1]=1（gainMarkers 生效）', async () => {
    const { service, markers, playerData } = makeItemSystem();
    const text = await service.craftItem(1, '升级探测雷达一', 1);
    expect(markers['探测雷达等级1']).toBe(1);
    expect(markers['制造']).toBe(1);
    expect(playerData.player.backpack.some((b: any) => b.name === '经验胶囊')).toBe(true);
    expect(text).toContain('经验胶囊');
  });

  it('gainMarkers 已有时拒绝重复制造（10/22 必刷同款防重复消耗）', async () => {
    const { service, markers } = makeItemSystem();
    markers['探测雷达等级1'] = 1;
    const text = await service.craftItem(1, '升级探测雷达一', 1);
    expect(text).toContain('不可以重复制造');
  });
});

describe('Issue #11：背包同名物品合并不再要求 type 一致', () => {
  it('同名不同 type 合并为一条：统一收敛到静态定义规范 type（物品）', () => {
    const { service } = makeItemSystem();
    const backpack: any[] = [
      { name: '经验胶囊', type: '资源', quantity: 400100, count: 400100 },
    ];
    (service as any).addItemToBackpack(backpack, { name: '经验胶囊', type: '物品', quantity: 400000 });
    expect(backpack).toHaveLength(1);
    expect(backpack[0].quantity).toBe(800100);
    // 规范化：type 由静态定义唯一决定（items.json 经验胶囊=物品），历史脏 type 被自愈
    expect(backpack[0].type).toBe('物品');
  });

  it('装备条目永不参与合并', () => {
    const { service } = makeItemSystem();
    const backpack: any[] = [{ name: '高斯步枪', type: '装备', quantity: 1, count: 1, data: 'a!bx1' }];
    (service as any).addItemToBackpack(backpack, { name: '高斯步枪', type: '装备', quantity: 1, count: 1, data: 'b!bx2' });
    expect(backpack).toHaveLength(2);
  });
});

describe('Issue #11：击杀结算写入玩家标记（扫荡需求计数源）', () => {
  function makeRecordKillsThis() {
    const achievementCalls: Array<[string, number]> = [];
    const taskCalls: Array<[string, number]> = [];
    const self: any = {
      logger: { warn: () => undefined, log: () => undefined },
      playerService: { getPlayerData: async () => ({ player: { name: '测试员' } }) },
      achievementService: {
        addAchievement: async (_p: any, name: string, value: number) => {
          achievementCalls.push([name, value]);
        },
      },
      taskService: { advance: async (_u: number, name: string, c?: number) => { taskCalls.push([name, c ?? 1]); } },
    };
    return { self, achievementCalls, taskCalls };
  }

  it('recordKills 同时写标记与任务：击败怪物/击败白虎', async () => {
    const { self, achievementCalls, taskCalls } = makeRecordKillsThis();
    await (CombatSystemService.prototype as any).recordKills.call(self, 1, ['白虎', '白虎', '青龙']);
    expect(achievementCalls).toContainEqual(['击败怪物', 3]);
    expect(achievementCalls).toContainEqual(['击败白虎', 2]);
    expect(achievementCalls).toContainEqual(['击败青龙', 1]);
    expect(taskCalls).toContainEqual(['击败怪物', 3]);
    expect(taskCalls).toContainEqual(['击败白虎', 2]);
  });

  it('空击杀列表直接返回，不写任何计数', async () => {
    const { self, achievementCalls } = makeRecordKillsThis();
    await (CombatSystemService.prototype as any).recordKills.call(self, 1, []);
    expect(achievementCalls).toHaveLength(0);
  });
});

describe('Issue #11：探测雷达扫描废弃载具等十类目标', () => {
  function makeRadarThis(maps: any[], demons: any[] = []) {
    const markers: Record<string, number> = {};
    const self: any = {
      logger: { warn: () => undefined, log: () => undefined },
      prisma: { gameMonster: { findMany: async () => demons } },
      playerService: {
        getPlayerData: async () => ({ player: { name: '测试员', markers } }),
        isPlayerDead: () => false,
        deathGateText: async () => null, // 未死放行（死亡门禁同源，桩场景恒放行）
      },
      achievementService: {
        getAchievement: (m: any, k: string) => m?.[k] ?? 0,
        setAchievement: () => undefined,
        addAchievement: async () => undefined,
      },
      mapService: { getAllMaps: async () => maps },
    };
    return { self, markers };
  }

  it('雷达输出包含 ◆废弃载具 与无主载具所在地图复活点', async () => {
    const maps = [
      {
        id: 3, name: '钢铁荒原', respawnPoint: '荒原入口',
        connections: [], summons: [], npcs: [], resources: [],
        vehicles: [{ owner: '无主', name: '废弃战车' }, { owner: '1', name: '私人轿车' }],
      },
      {
        id: 4, name: '绿洲镇', respawnPoint: '绿洲门',
        connections: [], summons: [{ name: '行商' }], npcs: [], resources: [],
        vehicles: [],
      },
    ];
    const { self } = makeRadarThis(maps);
    const text = await (GatherPanelService.prototype as any).handleProbeRadar.call(self, 1);
    expect(text).toContain('◆废弃载具: 荒原入口附近x1');
    expect(text).toContain('◆行商: 绿洲门附近x1');
  });

  it('雷达输出包含货舱/能量元素（复用 resources 聚合），等级0显示复活点附近', async () => {
    const maps = [
      {
        id: 5, name: '森林深处', respawnPoint: '森林出口',
        connections: [], summons: [], npcs: [],
        resources: [
          { name: '货舱', times: 3 },
          { name: '能量元素', times: 2 },
        ],
        vehicles: [],
      },
    ];
    const { self } = makeRadarThis(maps);
    const text = await (GatherPanelService.prototype as any).handleProbeRadar.call(self, 1);
    expect(text).toContain('◆货舱: 森林出口附近x3');
    expect(text).toContain('◆能量元素: 森林出口附近x2');
  });

  it('行商等级≥5 显示具体地图名', async () => {
    const maps = [
      {
        id: 6, name: '沙漠之心', respawnPoint: '沙漠入口',
        connections: [], summons: [{ name: '行商' }], npcs: [], resources: [], vehicles: [],
      },
    ];
    const { self } = makeRadarThis(maps);
    self.playerService.getPlayerData = async () => ({
      player: { name: '测试员', markers: { 探测雷达等级5: 1 } },
    });
    const text = await (GatherPanelService.prototype as any).handleProbeRadar.call(self, 1);
    expect(text).toContain('◆行商: 沙漠之心x1');
  });
});
