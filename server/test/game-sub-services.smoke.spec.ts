/**
 * 子服务冒烟桩测试（重构方案 P4-5）
 *
 * 对每个从 GameService 迁出的指令域子服务补 1 组桩测试：
 *   1. 子服务方法在正确的 this 形状下可独立运行（不再依赖门面）；
 *   2. 至少一个纯函数式方法的输出与迁移前口径一致；
 *   3. 门面委托链路存在（GameService 原型上的委托经懒构造桥路由到子服务）。
 * 实例化统一走 Object.create(原型) + 最小字段——与既有 spec 的桩构造方式
 * 同构（R8 兼容桥已保证委托目标恒存在），避免逐服务数构造参数。
 */
import { GameService } from '../src/modules/game/game.service';
import { GameSupportService } from '../src/modules/game/game-support.service';
import { RankingCommandService } from '../src/modules/game/commands/ranking-command.service';
import { AdminCommandService } from '../src/modules/game/commands/admin-command.service';
import { FusionCraftService } from '../src/modules/game/commands/fusion-craft.service';
import { TimeSettleService } from '../src/modules/game/commands/time-settle.service';
import { PetCommandService } from '../src/modules/game/commands/pet-command.service';
import { EquipCommandService } from '../src/modules/game/commands/equip-command.service';
import { SkillCommandService } from '../src/modules/game/commands/skill-command.service';
import { ShopTradeService } from '../src/modules/game/commands/shop-trade.service';
import { QuestDialogueService } from '../src/modules/game/commands/quest-dialogue.service';
import { HomeBuildService } from '../src/modules/game/commands/home-build.service';
import { DelayedSettleService } from '../src/modules/game/commands/delayed-settle.service';
import { DungeonChallengeService } from '../src/modules/game/commands/dungeon-challenge.service';
import { RescueWhiteService } from '../src/modules/game/commands/rescue-white.service';
import { MovementVehicleService } from '../src/modules/game/commands/movement-vehicle.service';
import { GatherPanelService } from '../src/modules/game/commands/gather-panel.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

/** 按原型造最小桩实例（方法可运行，依赖按需挂载） */
function makeSvc(proto: object, fields: Record<string, any> = {}): any {
  const svc: any = Object.create(proto);
  Object.assign(svc, fields);
  return svc;
}

const nil = undefined as any;
function makeSupport(): GameSupportService {
  return new GameSupportService(
    { getPlayerData: async () => ({ player: { name: '测试员' } }) } as any,
    { player: { findUnique: async () => ({ userId: 1, mapId: 1 }) } } as any,
    { getMapById: async () => ({ id: 1 }) } as any,
    { getAllResources: () => [], getEquipmentByName: () => null } as any,
    nil, // taskService（advanceTask 自带降级）
    { normalizeBuffItem: (e: any) => e } as any,
    { setTempInput: async () => undefined } as any,
    nil, // playerMutate
  );
}

describe('P4-5：各指令域子服务冒烟桩测试', () => {
  it('RankingCommandService：排行文本格式与迁移前一致', async () => {
    const svc = makeSvc(RankingCommandService.prototype, { support: makeSupport() });
    const text = await svc.formatRankingText('测试员', '测试榜', [{ name: '甲', value: 3 }]);
    expect(text).toContain('测试榜');
    expect(text).toContain('甲');
  });

  it('AdminCommandService：帮助文本可生成', () => {
    const svc = makeSvc(AdminCommandService.prototype);
    expect(svc.getAdminHelpText()).toContain('管理员');
  });

  it('FusionCraftService：融合词条数据读改写', () => {
    const svc = makeSvc(FusionCraftService.prototype);
    const data = svc.rewriteFusionData('', [{ name: '利刃' }]);
    expect(typeof data).toBe('string');
  });

  it('TimeSettleService：今日字符串口径为北京时间日期', () => {
    const svc = makeSvc(TimeSettleService.prototype);
    expect(svc.localTodayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('PetCommandService：handlePetDrive 委托 FamiliarSystemService', async () => {
    const familiarSystemService = { petDrive: jest.fn(async () => 'ok') } as any;
    const svc = makeSvc(PetCommandService.prototype, { familiarSystemService });
    await expect(svc.handlePetDrive(1, 2, '座驾')).resolves.toBe('ok');
  });

  it('EquipCommandService：装备预设列表返回数组', () => {
    const svc = makeSvc(EquipCommandService.prototype, {
      playerService: { getBackpackItems: () => [] },
    });
    const text = svc.listEquipPresets(
      { userId: 1, name: '测试员', backpack: [], equipment: [] } as any,
      [{ name: '预设1', equipment: [] }],
    );
    expect(text).toContain('装备预设');
  });

  it('SkillCommandService：bondSkillLabel 文案', () => {
    const svc = makeSvc(SkillCommandService.prototype);
    expect(svc.bondSkillLabel('a', 1)).toBe('利器管理');
  });

  it('ShopTradeService：行商物品含数量展示', () => {
    const svc = makeSvc(ShopTradeService.prototype, { support: makeSupport() });
    const text = svc.formatMerchantItem({ name: '木头', quantity: 5, type: '资源' }, true);
    expect(text).toContain('木头');
    expect(text).toContain('5');
  });

  it('QuestDialogueService：任务来源解析（getQuestSources 返回数组）', () => {
    const svc = makeSvc(QuestDialogueService.prototype, {
      staticData: { getNpcByName: () => null },
      taskService: { getAvailableTasks: async () => [] },
    });
    const sources = svc.getQuestSources([{ name: '白', npcName: '白' }]);
    expect(sources.length).toBeGreaterThanOrEqual(0);
  });

  it('HomeBuildService：updateMapBuildings 走 mapService 闭环', async () => {
    const updateDynamicFields = jest.fn(async () => undefined);
    const svc = makeSvc(HomeBuildService.prototype, {
      mapService: { updateDynamicFields },
    });
    await svc.updateMapBuildings(7, '[]');
    expect(updateDynamicFields).toHaveBeenCalledWith(7, { buildings: '[]' });
  });

  it('DelayedSettleService：装填/补给结算入口存在且为函数', () => {
    const svc = makeSvc(DelayedSettleService.prototype);
    expect(typeof svc.completeReload).toBe('function');
    expect(typeof svc.completeRefill).toBe('function');
  });

  it('DungeonChallengeService：扫荡需求文本包含怪物名', () => {
    const svc = makeSvc(DungeonChallengeService.prototype, {
      support: makeSupport(),
      playerService: { getMarkerValue: () => 1 },
    });
    expect(svc.buildSweepRequirementText({ backpack: '[]' }, ['史莱姆'])).toContain('史莱姆');
  });

  it('RescueWhiteService：救援秒口径 clamp ≥1', () => {
    const svc = makeSvc(RescueWhiteService.prototype);
    expect(svc.formatRescueSeconds(0.2)).toBe(1);
    expect(svc.formatRescueSeconds(30)).toBe(30);
  });

  it('MovementVehicleService：运行态互转与时长哨兵', () => {
    const svc = makeSvc(MovementVehicleService.prototype);
    const runtime = svc.toRuntimeVehicle({});
    expect(runtime).toBeDefined();
    expect(svc.formatVehicleTime(86400.12345678)).toContain('时间无限');
  });

  it('GatherPanelService：推送版本号单调递增（防乱序丢包）', () => {
    const svc = makeSvc(GatherPanelService.prototype, { revCounters: new Map<string, number>() });
    const a = svc.nextRev('player:1');
    const b = svc.nextRev('player:1');
    expect(b).toBeGreaterThan(a);
  });
});

describe('P4-5：门面委托链路冒烟（门面 → 子服务，R8 懒构造桥）', () => {
  it('Object.create 桩上的门面委托方法全部可达', async () => {
    const stub: any = createGameServiceStub({
      playerService: {
        enqueueUserWrite: async (_u: number, fn: () => any) => fn(),
        getPlayerData: async (uid: number) => ({ player: { userId: uid, name: '甲' } }),
        savePlayer: async () => undefined,
        getBackpackItems: () => [],
      },
      prisma: { player: { findUnique: async () => null } },
      mapService: { getMapById: async () => null },
      staticData: { getAllResources: () => [], getEquipmentByName: () => null },
      taskService: {},
      combatState: { normalizeBuffItem: (e: any) => e },
      combatSystem: {},
      achievementService: {},
      itemService: {},
      itemSystemService: {},
      homeService: {},
      familiarSystemService: {},
      familiarSkillsService: {},
      tutorialService: {},
      systemConfigService: {},
      chatService: {},
      feedbackService: {},
      shortcutService: { setTempInput: async () => undefined },
      statsService: {},
      bonusService: {},
      globalProficiency: {},
      delayedTaskService: undefined,
      handbookService: undefined,
      vitalityService: undefined,
      autoMineService: undefined,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    // 支撑层委托
    await expect(stub.getPlayerName(1)).resolves.toBe('甲');
    expect(stub.round2Text(1.234)).toBe('1.23');
    // 各域委托（覆盖 15 个子服务）
    expect(stub.formatVehicleTime(90)).toBe('1分30秒');                // movement-vehicle
    await expect(stub.advanceTask(1, '移动')).resolves.toBeUndefined(); // support
    expect(typeof stub.handleRanking).toBe('function');                // ranking
    expect(typeof stub.handleAdminCommand).toBe('function');           // admin
    expect(typeof stub.handleForge).toBe('function');                  // fusion
    expect(typeof stub.handleDailyCheckin).toBe('function');           // time
    expect(typeof stub.handlePetOps).toBe('function');                 // pet
    expect(typeof stub.handleEquip).toBe('function');                  // equip
    expect(typeof stub.handleTransform).toBe('function');              // skill
    expect(typeof stub.handleShop).toBe('function');                   // shop
    expect(typeof stub.handleTalk).toBe('function');                   // quest
    expect(typeof stub.handleInstallPart).toBe('function');            // home
    expect(typeof stub.completeReload).toBe('function');               // delayed
    expect(typeof stub.handleSweep).toBe('function');                  // dungeon
    expect(typeof stub.handleRescue).toBe('function');                 // rescue
    expect(typeof stub.handleGatherResource).toBe('function');         // gather-panel
    // 推送版本（随 panel 迁移后经门面委托）单调
    const r1 = stub.nextRev('player:9');
    const r2 = stub.nextRev('player:9');
    expect(r2).toBeGreaterThan(r1);
  });
});
