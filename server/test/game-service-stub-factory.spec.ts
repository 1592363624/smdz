/**
 * GameService 桩工厂契约测试（P1-6 建立，P4 过渡清理 B 批重写）
 *
 * 验证 test/helpers/game-service-stub.factory.ts 的「惰性挂载」语义：
 * 1. 按生产构造签名挂支撑层与全部 15 个子服务（首次访问时构建，委托目标非 undefined）；
 * 2. 跨域兄弟槽位已回填（movement↔panel 等互指边与生产 DI/forwardRef 等价）；
 * 3. mutatePlayer 的降级回退路径（无 PlayerMutateService 注入）行为不变；
 * 4. 测试显式提供的子服务/支撑层实例不被覆盖（可挂手写桩）。
 */
import { GameSupportService } from '../src/modules/game/game-support.service';
import { GatherPanelService } from '../src/modules/game/commands/gather-panel.service';
import { MovementVehicleService } from '../src/modules/game/commands/movement-vehicle.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

describe('GameService 桩工厂（惰性挂载）', () => {
  const saved: any[] = [];
  const stub = createGameServiceStub({
    playerService: {
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => any) => fn()),
      getPlayerData: jest.fn(async (uid: number) => ({
        player: { userId: uid, name: '甲', markers: {}, markers2: [] },
      })),
      savePlayer: jest.fn(async (player: any) => saved.push(player)),
    },
    prisma: { player: { findUnique: jest.fn(async () => ({ userId: 1, mapId: 7 })) } },
    mapService: { getMapById: jest.fn(async () => ({ id: 7, name: '医疗室' })) },
    staticData: { getAllResources: jest.fn(() => []) },
    taskService: { advance: jest.fn(async () => '') },
    combatState: { normalizeBuffItem: jest.fn((entry: any) => entry) },
  });

  it('工厂构造的桩上，支撑层与全部子服务首次访问即挂载（委托目标非 undefined）', () => {
    expect(stub.support).toBeInstanceOf(GameSupportService);
    expect(stub.gatherPanelService).toBeInstanceOf(GatherPanelService);
    expect(stub.movementVehicleService).toBeInstanceOf(MovementVehicleService);
  });

  it('跨域兄弟槽位已回填（与生产 DI / forwardRef 语义等价）', () => {
    const mv = stub.movementVehicleService;
    expect((mv as any).panel).toBe(stub.gatherPanelService);
    expect((mv as any).rescue).toBe(stub.rescueWhiteService);
    expect((mv as any).shop).toBe(stub.shopTradeService);
    expect((mv as any).homeBuild).toBe(stub.homeBuildService);
    expect((stub.gatherPanelService as any).movement).toBe(mv);
  });

  it('迁出的私有辅助经门面委托可达且行为一致', () => {
    expect(stub.round2Text(1.234)).toBe('1.23');
    expect(stub.millisecondsToText(90_000)).toBe('1分30秒');
    expect(stub.randomInt(2, 2)).toBe(2);
    expect(stub.parseJsonArray('[1,2]')).toEqual([1, 2]);
    expect(stub.firstPositiveNumber(0, 3, 5)).toBe(3);
  });

  it('mutatePlayer 走降级回退路径（enqueueUserWrite + getPlayerData + savePlayer）', async () => {
    const result = await stub.mutatePlayer(1, (ctx: any) => {
      ctx.player.name = '乙';
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(stub.playerService.enqueueUserWrite).toHaveBeenCalled();
    expect(stub.playerService.savePlayer).toHaveBeenCalled();
    expect(saved[0].name).toBe('乙');
  });

  it('advanceTask 在任务服务缺失时静默跳过（核心玩法不受影响）', async () => {
    const noTask = createGameServiceStub({ playerService: {}, prisma: {} });
    await expect(noTask.advanceTask(1, '移动', 3)).resolves.toBeUndefined();
  });

  it('先建桩后补字段：惰性构建读取的是首次访问时点的桩字段', () => {
    const late = createGameServiceStub({});
    late.playerService = { getPlayerData: async () => ({ player: { name: '丙' } }) } as any;
    expect(late.support).toBeInstanceOf(GameSupportService);
    expect((late.support as any).playerService).toBe(late.playerService);
  });

  it('测试显式提供的手写子服务桩不被工厂覆盖', () => {
    const handPanel = { handleLookAround: jest.fn(async () => '面板') };
    const custom = createGameServiceStub({ gatherPanelService: handPanel });
    expect(custom.gatherPanelService).toBe(handPanel);
  });
});
