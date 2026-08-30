/**
 * 双表示收敛回归：医疗箱永久标记不再被抹掉
 *
 * 历史根因：行 JSON 字段与顶层解析表示是两份独立数据，落库靠「基线对比 + 按侧
 * 猜测」调和。长活 Actor cell 的顶层表示落库后不推进 → 下一轮 mutate 的
 * syncParsedFields 把「行有顶层没有」误判为"业务只改顶层忘了写回行"，用陈旧
 * 顶层覆盖行 → 采集结算写入的「医疗箱」每人一次标记被抹掉 → 可反复开箱。
 *
 * 修复：行字段改造为读写都透传到顶层权威表示的 accessor
 * （PlayerService.installCanonicalAccessors），style A/B 物理上是同一份数据。
 * 本文件验证：行级写、顶层写、两种写法同 run/跨 run 混用，均不互相丢失。
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
  // 注册 'player' Actor 类型（生产由 onModuleInit 完成）
  void playerService.onModuleInit();
  const mutate = new PlayerMutateService(prisma, playerService, mutateContext);
  (mutate as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { prisma, runtime, playerService, mutate };
}

describe('活态 Actor cell 陈旧顶层字段抹掉行级标记（医疗箱重复打开根因）', () => {
  const rows = [{
    id: 1, userId: 42, version: 0, mapId: 1, location: '医疗室',
    backpack: '[]', markers: '{}', markers2: '[]', tasks: '[]',
  }];

  it('Run A 行级写标记落库后，Run B 的 mutate 不得用陈旧顶层覆盖它', async () => {
    const { prisma, playerService, mutate } = makeServices(rows);

    // Run A：模拟采集结算（直接 enqueueUserWrite 内改行字符串 markers）
    await playerService.enqueueUserWrite(42, async () => {
      const d = await playerService.getPlayerData(42);
      const markers = JSON.parse(d.player.markers || '{}');
      markers['医疗箱'] = 1; // 每人一次的永久标记
      d.player.markers = JSON.stringify(markers);
      await playerService.savePlayer(d.player);
    });

    const afterA = JSON.parse(rows[0].markers);
    expect(afterA['医疗箱']).toBe(1); // 落库成功

    // Run B：另一条 mutate 链只改 tasks（如任务推进），完全不碰 markers
    await mutate.mutate(42, async (ctx) => {
      ctx.tasks.push({ name: '新手教程', progress: 1 });
    });

    const afterB = JSON.parse(rows[0].markers);
    expect(afterB['医疗箱']).toBe(1); // ← 修复前此处被陈旧顶层 '{}' 覆盖而丢失
  });

  it('顶层 style A 改 markers 与行级改动在多次 run 间都能保留', async () => {
    const localRows = [{ ...rows[0] }];
    const { playerService, mutate } = makeServices(localRows);

    // Run A：行级写入永久标记
    await playerService.enqueueUserWrite(42, async () => {
      const d = await playerService.getPlayerData(42);
      const markers = JSON.parse(d.player.markers || '{}');
      markers['医疗箱'] = 1;
      d.player.markers = JSON.stringify(markers);
      await playerService.savePlayer(d.player);
    });

    // Run B：顶层 style A 写另一个标记
    await mutate.mutate(42, async (ctx) => {
      ctx.markers['伊卡洛斯好感'] = 5;
    });

    // Run C：又一条只读别的字段的 mutate
    await mutate.mutate(42, async (ctx) => {
      ctx.safeBox.push({ name: 'x' });
    });

    const final = JSON.parse(localRows[0].markers);
    expect(final['医疗箱']).toBe(1);
    expect(final['伊卡洛斯好感']).toBe(5);
  });

  it('同一 run 内先顶层 style A 再行级 style B 改 markers，两侧改动都保留', async () => {
    const localRows = [{ ...rows[0] }];
    const { playerService, mutate } = makeServices(localRows);

    // 对应历史真实场景：selectFamiliar 改顶层 markers（好感）、
    // ensureTutorialTasks 改行字符串 markers（教程）发生在同一条链上。
    await mutate.mutate(42, async (ctx) => {
      ctx.markers['伊卡洛斯好感'] = 5; // style A：直接改顶层对象
      const markers = JSON.parse(ctx.player.markers); // style B：解析行 getter
      markers['教程'] = 1;
      ctx.player.markers = JSON.stringify(markers); // 写回行 setter → 权威态
    });

    const final = JSON.parse(localRows[0].markers);
    expect(final['医疗箱']).toBe(1);
    expect(final['教程']).toBe(1);
  });

  it('邮箱内 savePlayer 传入裸行对象：cell 活态缺失时退回整包落库，不得崩溃', async () => {
    const localRows = [{ ...rows[0] }];
    const { prisma, playerService } = makeServices(localRows);

    await playerService.enqueueUserWrite(42, async () => {
      const d = await playerService.getPlayerData(42);
      // 模拟「非邮箱路径定点写后缓存失效」：cell 被删除，同一条异步链（als 仍
      // 持有 actor key）继续用先前拿到的裸行对象 savePlayer。
      (playerService as any).actorRuntime.invalidate('player', 42);
      d.player.markers = JSON.stringify({ 医疗箱: 1 });
      // 修复前：actor 分支取 target.player（裸行上不存在）→ applyLevelUps(undefined) 崩溃
      await playerService.savePlayer(d.player);
    });

    expect(JSON.parse(localRows[0].markers)['医疗箱']).toBe(1);
  });
});
