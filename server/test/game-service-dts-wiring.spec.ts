/**
 * 延时任务结算接线冒烟测试（重构方案 R9 / C5）
 *
 * 背景：GameService.onModuleInit 注册 12 个 dts.registerHandler 延时结算回调
 *（gather/move/rescue/reload/dungeonClose/mine/refill/cargo/repair/
 *   homeFoundation/homeConstruct/proxySpeak）。这是行为性接线而非纯 DI：
 * 注册块拆散或遗漏 → 延时结算静默失效，编译期与多数测试都发现不了。
 *
 * 门面拆分期间注册块必须整体保留在 GameService.onModuleInit（§4.2），
 * 回调体内 this.xxx 调用经门面委托触达迁移后的实现。本测试断言：
 *   1. 注册的延时 handler 数量 ≥ 12，且 12 个类型名一个不少；
 *   2. 回调体可调用（经门面委托走到委托目标，而非 undefined）；
 *   3. dts 缺席时静默降级（Object.create 测试桩路径，不得抛错）。
 */
import { GameService } from '../src/modules/game/game.service';

const EXPECTED_HANDLER_TYPES = [
  'gather',
  'move',
  'rescue',
  'reload',
  'dungeonClose',
  'mine',
  'refill',
  'cargo',
  'repair',
  'homeFoundation',
  'homeConstruct',
  'proxySpeak',
];

function makeWiredStub() {
  const registered = new Map<string, (task: any) => Promise<void>>();
  const dts = {
    registerHandler: (type: string, fn: (task: any) => Promise<void>) => {
      registered.set(type, fn);
    },
  };
  const stub: any = Object.create(GameService.prototype);
  stub.delayedTaskService = dts;
  stub.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  stub.onModuleInit();
  return { registered, stub };
}

describe('延时任务结算接线冒烟（R9）', () => {
  it('注册的延时 handler 数量 ≥ 12，且 12 个类型一个不少', () => {
    const { registered } = makeWiredStub();
    expect(registered.size).toBeGreaterThanOrEqual(12);
    for (const type of EXPECTED_HANDLER_TYPES) {
      expect(registered.has(type)).toBe(true);
    }
  });

  it('注册块中每个回调都是可调用函数（接线不得为空壳）', () => {
    const { registered } = makeWiredStub();
    for (const [type, fn] of registered) {
      expect(typeof fn).toBe('function');
    }
  });

  it('dts 缺席时 onModuleInit 静默降级（测试桩路径不得抛错）', () => {
    const stub: any = Object.create(GameService.prototype);
    expect(() => stub.onModuleInit()).not.toThrow();
  });

  it('回调体经门面委托触达实现（示例：gather 回调最终调 settleGatherResource）', async () => {
    const calls: any[] = [];
    const stub2: any = Object.create(GameService.prototype);
    const registered2 = new Map<string, (task: any) => Promise<void>>();
    stub2.delayedTaskService = {
      registerHandler: (type: string, fn: any) => registered2.set(type, fn),
    };
    stub2.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    // 覆写门面方法：回调体里的 this.settleGatherResource 必须经由桩对象命中
    // 覆写（证明注册回调走 this.xxx 委托链路，而非绑死旧实现）
    stub2.settleGatherResource = async (...args: any[]) => {
      calls.push(args);
      return '';
    };
    stub2.onModuleInit();
    await registered2.get('gather')!({ userId: '7' });
    expect(calls).toContainEqual([7]);
  });
});
