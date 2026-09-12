/**
 * GameService 测试桩统一工厂（game 模块化重构 P1-6）
 *
 * 背景：45 个 spec 以两种脆弱方式构造 GameService——
 *   1. 29 个位置参数 new GameService(...)（增删依赖即静默错位）；
 *   2. Object.create(GameService.prototype) 后手工挂依赖字段。
 * 方法迁出到子服务后，门面方法体改为一行委托；桩若未接上子服务，
 * 委托目标为 undefined → TypeError（风险 R8）。
 *
 * 本工厂是 R8 的固定缓解动作：
 *   - 构造「门面桩 + 已迁移子服务实例」：Object.create(GameService.prototype)
 *     后 Object.assign 依赖字段，并显式挂上 GameSupportService（用桩自身的
 *     playerService/prisma 等字段构造，行为与迁移前 this.X 直调完全一致）。
 *   - 门面上另有 supportSvc 懒构造访问器兜底（未注入时用桩字段现场构造），
 *     因此历史 spec 即使不经本工厂也能存活；新 spec 一律改用本工厂。
 *
 * 此后每批 P2/P3 迁移都必须让该批受影响 spec 改用本工厂构造（DoD 第 7 条）。
 */
import { GameService } from '../../src/modules/game/game.service';
import { GameSupportService } from '../../src/modules/game/game-support.service';

/** 门面桩依赖字段（全部可选，按被测方法所需提供） */
export type GameServiceStubFields = Record<string, any>;

/**
 * 构造 GameService 门面桩 + 已迁移子服务实例。
 * @param fields 挂到门面桩上的依赖/覆盖字段（playerService、prisma、mapService 等）
 */
export function createGameServiceStub(fields: GameServiceStubFields = {}): any {
  const stub: any = Object.create(GameService.prototype);
  Object.assign(stub, fields);
  // 显式接上支撑层：用桩自身的同名字段构造，保证委托行为与迁移前一致
  if (!stub.support) {
    stub.support = new GameSupportService(
      stub.playerService,
      stub.prisma,
      stub.mapService,
      stub.staticData,
      stub.taskService,
      stub.combatState,
      stub.playerMutate,
    );
  }
  return stub;
}
