/**
 * GameService 桩工厂契约测试（P1-6 / 风险 R8）
 *
 * 验证 test/helpers/game-service-stub.factory.ts 构造的「门面桩 + 支撑层实例」：
 * 1. 迁出到 GameSupportService 的方法经门面委托可达（委托目标非 undefined）；
 * 2. mutatePlayer 的降级回退路径（无 PlayerMutateService 注入）行为不变；
 * 3. 懒构造兜底：Object.create 桩即使不走工厂也能拿到委托目标（历史 spec 兼容）。
 */
import { GameService } from '../src/modules/game/game.service';
import { GameSupportService } from '../src/modules/game/game-support.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

describe('GameService 桩工厂（R8 固定缓解）', () => {
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

  it('工厂构造的桩上，支撑层已显式接线（委托目标非 undefined）', () => {
    expect(stub.support).toBeInstanceOf(GameSupportService);
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

  it('懒构造兜底：Object.create 桩未挂 support 时委托仍可用（历史 spec 兼容）', () => {
    const legacy: any = Object.create(GameService.prototype);
    legacy.playerService = stub.playerService;
    legacy.prisma = stub.prisma;
    legacy.mapService = stub.mapService;
    legacy.staticData = stub.staticData;
    legacy.taskService = stub.taskService;
    legacy.combatState = stub.combatState;
    // 不设置 support——访问 supportSvc 时应用桩字段懒构造
    expect(legacy.support).toBeUndefined();
    expect(legacy.round2Text(2)).toBe('2');
    expect(legacy.support).toBeInstanceOf(GameSupportService);
  });
});
