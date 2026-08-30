/**
 * 回归：mutate 的 ALS 上下文逃逸进定时器，导致延时结算静默丢失
 *
 * 根因（医疗箱/休眠仓可无限重复采集的反复复发根因）：
 * 采集开始路径跑在 mutatePlayer（mutate ALS）内，10~16s 的采集定时器在该 ALS
 * 作用域内调度。Node 的 AsyncLocalStorage 会跟随 setTimeout 回调，定时器触发时
 * settleGatherResource 的整条异步链仍持有开始那条链的 ALS 快照——
 * mutateContext.currentFor(userId) 返回早已收口的开始命令上下文，
 * savePlayer 误入「合并进 mutate 上下文」分支提前 return，
 * ActorRuntime.markDirty() 永远不会被调用 → cell.dirty=false →
 * writeThrough 跳过落库 → 结算写入的永久标记（医疗箱/休眠仓）只存在于内存。
 * 5 秒兜底扫描随后发现库里的「采集中」已过期且指纹已结算，走清理分支，
 * 用扫描时读到的陈旧 markers 整列覆盖 → 标记彻底丢失 → 资源可无限重复采集。
 *
 * 修复：mutate/read 收口时把上下文登记为已结束（WeakSet），已收口上下文对
 * 后续异步链（含 ALS 逃逸进定时器的回调）不可见，savePlayer 走正常 Actor 分支。
 *
 * 本测试用真实 AsyncLocalStorage + 真实定时器复现逃逸场景：
 * mutate 内改 markers + 调度 setTimeout，定时器回调中再走
 * enqueueUserWrite → getPlayerData → 改标记 → savePlayer，
 * 断言改动最终落库。
 */

import { PlayerService } from '../src/modules/game/player.service';
import { PlayerMutateService } from '../src/modules/game/player-mutate.service';
import { PlayerMutateContextService } from '../src/modules/game/player-mutate-context.service';
import { ActorRuntime } from '../src/modules/actor/actor-runtime';
import { StaticDataService } from '../src/modules/game/static-data.service';

function makePrisma(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.userId === where?.userId);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where?.id);
        if (!row) {
          const err: any = new Error('not found'); err.code = 'P2025'; throw err;
        }
        Object.assign(row, data);
        row.version = Number(row.version ?? 0) + 1;
        return { ...row };
      }),
    },
    currencyLog: { create: jest.fn(async () => undefined) },
  };
  return prisma;
}

function makeServices(rows: any[]) {
  const prisma = makePrisma(rows);
  const runtime = new ActorRuntime({ flushIntervalMs: 0 });
  const playerService = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
    undefined,
    runtime,
  );
  (playerService as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const mutateContext = new PlayerMutateContextService();
  void playerService.onModuleInit();
  const mutate = new PlayerMutateService(prisma, playerService, mutateContext);
  (mutate as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { prisma, runtime, playerService, mutate };
}

describe('mutate ALS 逃逸进定时器：延时结算的改动必须落库', () => {
  it('定时器回调（仍携带开始链的 ALS）内 savePlayer 的标记改动要写入数据库', async () => {
    const rows: any[] = [{
      id: 1, userId: 501, name: '测试者', level: 1, exp: 0, version: 0, mapId: 1,
      markers: JSON.stringify({ 活力2: 100 }),
      markers2: '[]', backpack: '[]', tasks: '[]',
    }];
    const { prisma, mutate } = makeServices(rows);

    // 模拟采集开始：在 mutate 内改 markers，并调度定时器（ALS 随之逃逸）
    await new Promise<void>((resolveTimer) => {
      void mutate.mutate(501, async (ctx) => {
        ctx.markers['采集中'] = { target: '医疗箱' };
        // 模拟 10~16s 的采集延时定时器（缩到 30ms），回调里做「结算」
        setTimeout(() => {
          void (async () => {
            // 结算路径：enqueueUserWrite（Actor 邮箱）内改标记 + savePlayer。
            // 修复前：此处 currentFor(501) 仍返回开始的死上下文 → savePlayer 合并进
            // 死上下文并提前返回 → markDirty 不被调用 → 以下改动永不落库。
            await mutate.mutate(501, async (settleCtx) => {
              delete settleCtx.markers['采集中'];
              settleCtx.markers['医疗箱'] = 1;
            });
            resolveTimer();
          })();
        }, 30);
      });
    });

    // 给 Actor writeThrough 一点时间完成落库
    await new Promise((r) => setTimeout(r, 50));

    const row = rows.find((r) => r.userId === 501)!;
    const markers = JSON.parse(row.markers);
    // 修复前失败点：医疗箱标记与采集中清理都停留在内存，库里永远是旧值
    expect(markers['医疗箱']).toBe(1);
    expect(markers['采集中']).toBeUndefined();
    // 开始路径自身的改动也应已落库
    expect(prisma.player.update).toHaveBeenCalled();
  });
});
