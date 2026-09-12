/**
 * GameService 测试桩统一工厂（game 模块化重构 P1-6 建立，P4 过渡清理 B 批重写）
 *
 * 职责：替代原 GameService 门面上的 16 个懒构造桥——门面构造器在清理后只保留
 * 必选依赖，「Object.create(GameService.prototype) + 手挂字段」式测试桩统一改走
 * 本工厂。挂载语义与原桥完全一致：
 *   - **惰性**：支撑层/子服务在首次被访问时才用桩当前字段构建（桩可以
 *     先建桩、后补 prisma/playerService 等字段，再触发门面方法）；
 *   - **可覆盖**：测试随时可以给任意依赖赋手写桩（setter 记忆，getter 返回）；
 *   - **兄弟互指安全**：子服务的跨域兄弟槽位先占位后回填，movement↔panel
 *     等互指边与生产 DI / forwardRef 语义等价。
 *
 * 每个子服务新增/调整构造参数时，同步维护 defineLazyMounts 中的对应构造行。
 */
import { GameService } from '../../src/modules/game/game.service';
import { GameSupportService } from '../../src/modules/game/game-support.service';
import { RankingCommandService } from '../../src/modules/game/commands/ranking-command.service';
import { AdminCommandService } from '../../src/modules/game/commands/admin-command.service';
import { FusionCraftService } from '../../src/modules/game/commands/fusion-craft.service';
import { TimeSettleService } from '../../src/modules/game/commands/time-settle.service';
import { PetCommandService } from '../../src/modules/game/commands/pet-command.service';
import { EquipCommandService } from '../../src/modules/game/commands/equip-command.service';
import { SkillCommandService } from '../../src/modules/game/commands/skill-command.service';
import { ShopTradeService } from '../../src/modules/game/commands/shop-trade.service';
import { QuestDialogueService } from '../../src/modules/game/commands/quest-dialogue.service';
import { HomeBuildService } from '../../src/modules/game/commands/home-build.service';
import { DelayedSettleService } from '../../src/modules/game/commands/delayed-settle.service';
import { DungeonChallengeService } from '../../src/modules/game/commands/dungeon-challenge.service';
import { RescueWhiteService } from '../../src/modules/game/commands/rescue-white.service';
import { MovementVehicleService } from '../../src/modules/game/commands/movement-vehicle.service';
import { GatherPanelService } from '../../src/modules/game/commands/gather-panel.service';

/** 门面桩依赖字段（全部可选，按被测方法所需提供） */
export type GameServiceStubFields = Record<string, any>;

/**
 * 构造 GameService 门面桩：挂依赖字段 + 定义支撑层/全部子服务的惰性挂载点。
 * @param fields 挂到门面桩上的依赖/覆盖字段（playerService、prisma、mapService 等）
 */
export function createGameServiceStub(fields: GameServiceStubFields = {}): any {
  const stub: any = Object.create(GameService.prototype);
  Object.assign(stub, fields);
  defineLazyMounts(stub);
  return stub;
}

/**
 * 在桩上定义一个惰性挂载点：首次读取时用桩当前字段构建；任何赋值（含
 * Object.assign / 直接赋值手写桩）都会被记住并优先返回。
 */
function defineLazyMount(stub: any, name: string, construct: (s: any) => any): void {
  let value: any = stub[name]; // 保留测试显式提供的实例/手写桩
  Object.defineProperty(stub, name, {
    configurable: true,
    get() {
      if (value == null) {
        value = construct(stub);
      }
      return value;
    },
    set(v: any) {
      value = v;
    },
  });
}

/** 在桩上定义支撑层与全部 15 个子服务的惰性挂载点（构造签名=生产构造器）。 */
function defineLazyMounts(stub: any): void {
  defineLazyMount(stub, 'support', (s) => new GameSupportService(
    s.playerService, s.prisma, s.mapService, s.staticData, s.taskService, s.combatState, s.shortcutService, s.playerMutate,
  ));

  defineLazyMount(stub, 'rankingService', (s) => new RankingCommandService(
    s.support, s.prisma, s.playerService, s.bonusService, s.combatSystem, s.itemService, s.combatState,
  ));

  defineLazyMount(stub, 'adminCommandService', (s) => new AdminCommandService(
    s.support, s.prisma, s.adminService, s.delayedTaskService,
  ));

  defineLazyMount(stub, 'fusionCraftService', (s) => new FusionCraftService(
    s.support, s.playerService, s.itemService, s.mapService, s.itemSystemService, s.staticData, s.shortcutService,
  ));

  defineLazyMount(stub, 'timeSettleService', (s) => new TimeSettleService(
    s.support, s.playerService, s.combatSystem, s.staticData, s.taskService, s.statsService, s.combatState,
    s.vitalityService, s.playerMutate,
  ));

  defineLazyMount(stub, 'petCommandService', (s) => new PetCommandService(
    s.support, s.prisma, s.playerService, s.mapService, s.familiarSystemService, s.familiarSkillsService, s.staticData, s.combatState,
  ));

  defineLazyMount(stub, 'equipCommandService', (s) => new EquipCommandService(
    s.support, s.playerService, s.itemService, s.itemSystemService, s.staticData, s.combatState,
  ));

  defineLazyMount(stub, 'skillCommandService', (s) => {
    const inst = new SkillCommandService(
      s.support, s.prisma, s.playerService, s.mapService, s.familiarSystemService, s.familiarSkillsService,
      s.staticData, s.combatState, undefined as any, s.globalProficiency,
    );
    s.skillCommandService = inst; // 先占位，兄弟回指时直接命中
    (inst as any).rescue = s.rescueWhiteService;
    return inst;
  });

  defineLazyMount(stub, 'shopTradeService', (s) => {
    const inst = new ShopTradeService(
      s.support, s.prisma, s.playerService, s.itemService, s.mapService, s.achievementService,
      s.itemSystemService, s.homeService, s.familiarSystemService, s.staticData, s.taskService, undefined as any,
    );
    s.shopTradeService = inst;
    (inst as any).fusion = s.fusionCraftService;
    return inst;
  });

  defineLazyMount(stub, 'questDialogueService', (s) => {
    const inst = new QuestDialogueService(
      s.support, s.prisma, s.playerService, s.combatSystem, s.mapService, s.achievementService,
      s.familiarSystemService, s.familiarSkillsService, s.tutorialService, s.staticData, s.systemConfigService,
      s.chatService, s.feedbackService, s.taskService, s.shortcutService,
      undefined as any, undefined as any, s.handbookService,
    );
    s.questDialogueService = inst;
    (inst as any).rescue = s.rescueWhiteService;
    (inst as any).movement = s.movementVehicleService;
    return inst;
  });

  defineLazyMount(stub, 'homeBuildService', (s) => {
    const inst = new HomeBuildService(
      s.support, s.shopTradeService, s.prisma, s.playerService, s.mapService, s.homeService,
      s.familiarSystemService, s.staticData, s.taskService, s.combatState,
      undefined as any, undefined as any, s.delayedTaskService,
    );
    s.homeBuildService = inst;
    (inst as any).movement = s.movementVehicleService;
    (inst as any).panel = s.gatherPanelService;
    return inst;
  });

  defineLazyMount(stub, 'delayedSettleService', (s) => {
    const inst = new DelayedSettleService(
      s.support, s.prisma, s.playerService, s.mapService, s.achievementService, s.homeService,
      s.staticData, s.chatService, s.taskService, s.combatState,
      undefined as any, s.delayedTaskService,
    );
    s.delayedSettleService = inst;
    (inst as any).panel = s.gatherPanelService;
    return inst;
  });

  defineLazyMount(stub, 'dungeonChallengeService', (s) => {
    const inst = new DungeonChallengeService(
      s.support, s.prisma, s.playerService, s.combatSystem, s.mapService, s.dungeonService,
      s.achievementService, s.itemSystemService, s.familiarSkillsService, s.staticData, s.taskService,
      s.shortcutService, s.combatState, undefined as any, undefined as any,
      s.vitalityService, s.delayedTaskService,
    );
    s.dungeonChallengeService = inst;
    (inst as any).panel = s.gatherPanelService;
    (inst as any).movement = s.movementVehicleService;
    return inst;
  });

  defineLazyMount(stub, 'rescueWhiteService', (s) => {
    const inst = new RescueWhiteService(
      s.support, s.prisma, s.playerService, s.combatSystem, s.mapService, s.chatService, s.taskService,
      undefined as any, s.delayedTaskService,
    );
    s.rescueWhiteService = inst;
    (inst as any).movement = s.movementVehicleService;
    return inst;
  });

  defineLazyMount(stub, 'movementVehicleService', (s) => {
    const inst = new MovementVehicleService(
      s.support, s.prisma, s.playerService, s.combatSystem, s.mapService, s.achievementService,
      s.familiarSystemService, s.staticData, s.systemConfigService, s.chatService, s.taskService,
      s.shortcutService, s.combatState, undefined as any, undefined as any, undefined as any, undefined as any,
      s.delayedTaskService,
    );
    s.movementVehicleService = inst;
    (inst as any).panel = s.gatherPanelService;
    (inst as any).homeBuild = s.homeBuildService;
    (inst as any).rescue = s.rescueWhiteService;
    (inst as any).shop = s.shopTradeService;
    return inst;
  });

  defineLazyMount(stub, 'gatherPanelService', (s) => {
    const inst = new GatherPanelService(
      s.support, s.prisma, s.playerService, s.bonusService, s.combatSystem, s.itemService, s.mapService,
      s.familiarService, s.achievementService, s.itemSystemService, s.homeService, s.familiarSystemService,
      s.staticData, s.chatService, s.taskService, s.shortcutService, s.statsService, s.combatState,
      undefined as any, undefined as any, s.autoMineService, s.vitalityService, s.delayedTaskService,
    );
    s.gatherPanelService = inst;
    (inst as any).movement = s.movementVehicleService;
    (inst as any).rescue = s.rescueWhiteService;
    return inst;
  });
}
