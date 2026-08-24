/**
 * 数据→UI 自动同步核心单元测试
 * 覆盖：ChangeBus 事件分发与容错、write-inspect 参数解析、SyncProjector 投影逻辑。
 * 全部使用 stub，不依赖数据库。
 */

import { ChangeBusService } from '../src/game-sync/change-bus.service';
import { SyncProjectorService } from '../src/game-sync/sync-projector.service';
import { inspectWriteParams } from '../src/game-sync/write-inspect';

describe('ChangeBusService', () => {
  it('emit 后监听器收到事件', () => {
    const bus = new ChangeBusService();
    const received: any[] = [];
    bus.on((e) => received.push(e));
    bus.emit({ entity: 'player', userId: 7 });
    expect(received).toEqual([{ entity: 'player', userId: 7 }]);
  });

  it('单个监听器抛错不影响其他监听器', () => {
    const bus = new ChangeBusService();
    const received: any[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on((e) => received.push(e));
    bus.emit({ entity: 'monster', monsterId: 1, mapId: 2 });
    expect(received.length).toBe(1);
  });

  it('on 返回的退订函数生效', () => {
    const bus = new ChangeBusService();
    const received: any[] = [];
    const off = bus.on((e) => received.push(e));
    off();
    bus.emit({ entity: 'player', userId: 1 });
    expect(received.length).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('inspectWriteParams', () => {
  it('Player update 按 where.id 定位（savePlayer 形态）', () => {
    expect(inspectWriteParams('Player', 'update', { where: { id: 5 }, data: { hp: 1 } })).toEqual({
      entity: 'player',
      userId: 5,
    });
  });

  it('Player updateMany 按 where.userId 精确值定位', () => {
    expect(
      inspectWriteParams('Player', 'updateMany', { where: { userId: 9 }, data: {} }),
    ).toEqual({ entity: 'player', userId: 9 });
  });

  it('Player updateMany 仅含范围过滤（gt）无法枚举受影响用户 → null', () => {
    expect(
      inspectWriteParams('Player', 'updateMany', { where: { userId: { gt: 0 } }, data: {} }),
    ).toBeNull();
  });

  it('Player where.userId OR 数组浅层解析', () => {
    expect(
      inspectWriteParams('Player', 'updateMany', {
        where: { OR: [{ nickname: 'x' }, { userId: 9 }] },
        data: {},
      }),
    ).toEqual({ entity: 'player', userId: 9 });
  });

  it('Player 无法定位归属时返回 null', () => {
    expect(inspectWriteParams('Player', 'deleteMany', { where: {} })).toBeNull();
  });

  it('GameMonster 仅 where.id 无 mapId → null（由 MapService 收口补发）', () => {
    expect(
      inspectWriteParams('GameMonster', 'update', { where: { id: 3 }, data: { hp: 10 } }),
    ).toBeNull();
  });

  it('GameMonster 按 data.mapId 定位（create/整行写回形态）', () => {
    expect(
      inspectWriteParams('GameMonster', 'update', { where: { id: 3 }, data: { hp: 10, mapId: 7 } }),
    ).toEqual({ entity: 'monster', monsterId: 3, mapId: 7 });
  });
});

describe('SyncProjectorService.project', () => {
  const makeProjector = () => {
    const findMany = jest.fn().mockResolvedValue([{ userId: 1 }, { userId: 2 }, { userId: 3 }]);
    const prismaStub: any = { player: { findMany } };
    const statsStub: any = { getOnlineUserIds: () => new Set([1, 3]) }; // 用户2离线
    const pushed: string[] = [];
    const gameStub: any = {
      pushPlayerUpdate: jest.fn(async (uid: number) => void pushed.push(`p${uid}`)),
      pushMapUpdate: jest.fn(async (uid: number) => void pushed.push(`m${uid}`)),
    };
    const projector = new SyncProjectorService(
      new ChangeBusService(),
      prismaStub,
      statsStub,
      gameStub,
    );
    return { projector, findMany, gameStub, pushed };
  };

  it('player 变更只投影到本人', async () => {
    const { projector, gameStub } = makeProjector();
    projector.project({ entity: 'player', userId: 42 });
    // push 内部是异步防抖包装，等待微任务
    await Promise.resolve();
    expect(gameStub.pushPlayerUpdate).toHaveBeenCalledWith(42);
    expect(gameStub.pushMapUpdate).not.toHaveBeenCalled();
  });

  it('monster 变更投影到该地图全部在线玩家（跨玩家视野）', async () => {
    const { projector, findMany, gameStub } = makeProjector();
    projector.project({ entity: 'monster', monsterId: 9, mapId: 77 });
    await Promise.resolve();
    expect(findMany).toHaveBeenCalledWith({ where: { mapId: 77 }, select: { userId: true } });
    expect(gameStub.pushMapUpdate).toHaveBeenCalledTimes(2); // 用户2离线被过滤
    expect(gameStub.pushMapUpdate).toHaveBeenCalledWith(1);
    expect(gameStub.pushMapUpdate).toHaveBeenCalledWith(3);
  });

  it('订阅后 emit 自动触发投影；退订后停止', async () => {
    const { projector, gameStub } = makeProjector();
    const bus = new ChangeBusService();
    (projector as any).changeBus = bus;
    projector.onApplicationBootstrap();
    bus.emit({ entity: 'player', userId: 8 });
    await Promise.resolve();
    expect(gameStub.pushPlayerUpdate).toHaveBeenCalledWith(8);
    projector.onApplicationShutdown();
    bus.emit({ entity: 'player', userId: 9 });
    await Promise.resolve();
    expect(gameStub.pushPlayerUpdate).toHaveBeenCalledTimes(1);
  });
});
