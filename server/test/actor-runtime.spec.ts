/**
 * Actor 运行时单元测试
 *
 * 目标：验证「单进程内、每实体一个串行邮箱 + 内存态 + 异步落库」的核心不变量，
 * 以及 hardening 后的正确性 / 健壮性 / 可观测性：
 *  1. 同实体写操作严格串行（单时刻一条，无 interleaving）—— 无锁无 CAS 的并发正确性基础
 *  2. 内存态单激活（并发 run 只 load 一次）
 *  3. peek 返回【深克隆只读快照】，外部改它不会污染内存态（正确性风险 #1 修复）
 *  4. writeThrough：仅当标脏（markDirty）才落库；纯只读 run 不白吞 DB 写（性能修复）
 *  5. deferred + deactivate：仅标脏，停用/周期才落库
 *  6. run fn 抛错 → 内存态被丢弃、不落库（all-or-nothing，正确性风险 #3 修复）
 *  7. 跨实体协调者（coordinate）：字典序确定性排序，打破 A↔B 死锁环路
 *  8. LRU 驱逐 + 周期空闲回收（干净空闲 cell 也回收，健壮性缺口修复）
 *  9. 邮箱背压：积压超限抛 ActorMailboxOverflowError（并发健壮性修复）
 * 10. deactivate 经邮箱排队，不与在途 run 竞争（正确性风险 #4 修复）
 * 11. stats() 可观测性计数
 *
 * 不依赖 Nest DI：直接 new ActorRuntime（构造仅接收配置，无需容器）。
 */

import { ActorRuntime, ActorMailboxOverflowError } from '../src/modules/actor';
import { coordinate } from '../src/modules/actor';

function inMemoryType(backing: Record<string, any>) {
  let loadCalls = 0;
  let saveCalls = 0;
  const cfg = {
    load: async (id: string | number) => {
      loadCalls++;
      const v = backing[String(id)];
      if (v === undefined) throw new Error(`no such entity: ${id}`);
      return JSON.parse(JSON.stringify(v));
    },
    save: async (id: string | number, state: any) => {
      saveCalls++;
      backing[String(id)] = JSON.parse(JSON.stringify(state));
    },
    persist: 'writeThrough' as const,
  };
  return { cfg, getLoadCalls: () => loadCalls, getSaveCalls: () => saveCalls };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ActorRuntime 核心不变量', () => {
  it('同 key 的 run 严格串行执行，无 interleaving', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType({ x: { n: 0 } });
    rt.registerType('k', cfg);
    const events: string[] = [];
    const p1 = rt.run('k', 'x', async (s: any) => {
      events.push('a-start');
      await delay(20);
      s.n += 1;
      rt.markDirty();
      events.push('a-end');
      return s.n;
    });
    const p2 = rt.run('k', 'x', async (s: any) => {
      events.push('b-start');
      s.n += 1;
      rt.markDirty();
      events.push('b-end');
      return s.n;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it('并发 run 只激活（load）一次', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg, getLoadCalls } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    await Promise.all([
      rt.run('k', 'x', async () => {
        await delay(10);
      }),
      rt.run('k', 'x', async () => {
        await delay(10);
      }),
    ]);
    expect(getLoadCalls()).toBe(1);
  });

  it('peek 返回深克隆只读快照，改它不会污染真实内存态（风险#1 修复）', async () => {
    const backing: Record<string, any> = { x: { v: 1, list: [1] } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType(backing);
    rt.registerType('k', cfg);
    await rt.run('k', 'x', async () => {}); // 激活
    const snapshot = rt.peek('k', 'x') as any;
    expect(snapshot).toBeDefined();
    // 克隆：引用不同
    expect(rt.peek('k', 'x')).not.toBe(snapshot);
    // 改克隆不影响真实 state
    snapshot.v = 999;
    snapshot.list.push(2);
    const real = rt.peek('k', 'x') as any;
    expect(real.v).toBe(1);
    expect(real.list).toEqual([1]);
  });

  it('writeThrough：标脏后才落库；纯只读 run 不落库（性能修复）', async () => {
    const backing: Record<string, any> = { x: { v: 5 } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg, getSaveCalls } = inMemoryType(backing);
    rt.registerType('k', cfg);

    // 只读 run：不应落库
    await rt.run('k', 'x', async (s: any) => {
      void s.v;
    });
    expect(getSaveCalls()).toBe(0);

    // 写后标脏：应落库
    await rt.run('k', 'x', async (s: any) => {
      s.v = 99;
      rt.markDirty();
    });
    expect(getSaveCalls()).toBe(1);
    expect(backing.x.v).toBe(99);
  });

  it('deferred + deactivate：写后不立即落库，停用才落库并清内存', async () => {
    const backing: Record<string, any> = { x: { v: 1 } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg, getSaveCalls } = inMemoryType(backing);
    rt.registerType('k', { ...cfg, persist: 'deferred' });
    await rt.run('k', 'x', async (s: any) => {
      s.v = 42;
      rt.markDirty();
    });
    expect(getSaveCalls()).toBe(0); // deferred 不立即落库
    expect(backing.x.v).toBe(1);
    await rt.deactivate('k', 'x');
    expect(getSaveCalls()).toBe(1);
    expect(backing.x.v).toBe(42); // 停用触发落库
    expect(rt.peek('k', 'x')).toBeUndefined(); // 内存已移除
  });

  it('未激活的 peek 返回 undefined（不会触发 load）', () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    expect(rt.peek('k', 'x')).toBeUndefined();
  });

  it('run fn 抛错：内存态被丢弃、不落库、向上抛出（all-or-nothing）', async () => {
    const backing: Record<string, any> = { x: { v: 1 } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg, getSaveCalls } = inMemoryType(backing);
    rt.registerType('k', cfg);
    let threw = false;
    try {
      await rt.run('k', 'x', async (s: any) => {
        s.v = 777; // 半截改动
        rt.markDirty();
        throw new Error('boom');
      });
    } catch (e) {
      threw = (e as Error).message === 'boom';
    }
    expect(threw).toBe(true);
    expect(getSaveCalls()).toBe(0); // 半截改动绝不落库
    expect(backing.x.v).toBe(1); // 库未变
    // 下一次 run 重新从库载入干净状态
    await rt.run('k', 'x', async (s: any) => {
      expect(s.v).toBe(1);
    });
  });

  it('邮箱背压：积压超 mailboxMaxDepth 抛 ActorMailboxOverflowError', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0, mailboxMaxDepth: 1 });
    const { cfg } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    const slow = rt.run('k', 'x', async () => {
      await delay(50);
    });
    let overflowed = false;
    try {
      await rt.run('k', 'x', async () => {});
    } catch (e) {
      overflowed = e instanceof ActorMailboxOverflowError;
    }
    await slow;
    expect(overflowed).toBe(true);
    expect(rt.stats().totalOverflow).toBeGreaterThanOrEqual(1);
  });

  it('deactivate 经邮箱排队：等在场 run 完成后再卸载（风险#4 修复）', async () => {
    const backing: Record<string, any> = { x: { v: 1 } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg, getSaveCalls } = inMemoryType(backing);
    rt.registerType('k', cfg);
    let runSaved = false;
    const runP = rt.run('k', 'x', async (s: any) => {
      s.v = 10;
      rt.markDirty();
      await delay(30);
      runSaved = true;
    });
    const deactP = rt.deactivate('k', 'x');
    // deactivate 不应在 run 之前完成
    await Promise.all([runP, deactP]);
    expect(runSaved).toBe(true);
    expect(getSaveCalls()).toBe(1);
    expect(backing.x.v).toBe(10);
  });

  it('stats() 暴露落库/驱逐/溢出计数', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    await rt.run('k', 'x', async (s: any) => {
      s.v = 2;
      rt.markDirty();
    });
    const st = rt.stats();
    expect(st.cells).toBe(1);
    expect(st.totalPersists).toBe(1);
    expect(st.byType.k).toBe(1);
  });
});

describe('周期空闲回收（干净 cell 也回收）', () => {
  it('超过 idleEvictMs 的干净 cell 被驱逐回收', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 20, idleEvictMs: 30, lruMax: 100 });
    const { cfg } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    await rt.run('k', 'x', async () => {}); // 激活一个干净 cell
    expect(rt.peek('k', 'x')).toBeDefined();
    await delay(120); // 等周期落库 + 空闲回收
    expect(rt.peek('k', 'x')).toBeUndefined(); // 干净空闲 cell 已被回收
  });

  it('超过 idleEvictMs 的脏 cell 先落库再回收', async () => {
    const backing: Record<string, any> = { x: { v: 1 } };
    const rt = new ActorRuntime({ flushIntervalMs: 20, idleEvictMs: 30, lruMax: 100 });
    const { cfg } = inMemoryType(backing);
    rt.registerType('k', cfg);
    await rt.run('k', 'x', async (s: any) => {
      s.v = 7;
      rt.markDirty();
    });
    await delay(120);
    expect(backing.x.v).toBe(7); // 脏 cell 被周期落库
    expect(rt.peek('k', 'x')).toBeUndefined(); // 随后回收
  });
});

describe('LRU 驱逐', () => {
  it('超过 lruMax 时按最久未用淘汰（非脏 cell 直接移除）', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0, lruMax: 2 });
    const { cfg } = inMemoryType({ '1': { id: 1 }, '2': { id: 2 }, '3': { id: 3 } });
    rt.registerType('k', cfg);
    await rt.run('k', '1', async () => {});
    await rt.run('k', '2', async () => {});
    await rt.run('k', '3', async () => {}); // 触发驱逐
    expect(rt.peek('k', '1')).toBeUndefined(); // 最久未用被逐出
    expect(rt.peek('k', '2')).toBeDefined();
    expect(rt.peek('k', '3')).toBeDefined();
  });
});

describe('跨实体协调者 coordinate（防死锁）', () => {
  it('无论传入顺序如何都不死锁，且两笔并发转账结果确定一致', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    rt.registerType('k', {
      load: async (id) => ({ id, bal: 100 }),
      save: async () => {},
      persist: 'writeThrough',
    });

    async function transfer(from: string, to: string) {
      await coordinate(
        rt,
        { type: 'k', id: from },
        { type: 'k', id: to },
        async (a: any, b: any) => {
          a.bal -= 10;
          b.bal += 10;
          rt.markDirty();
        },
      );
    }

    await Promise.all([transfer('A', 'B'), transfer('B', 'A')]);

    const pa = rt.peek('k', 'A') as any;
    const pb = rt.peek('k', 'B') as any;
    expect(pa.bal).toBe(100);
    expect(pb.bal).toBe(100);
  });

  it('coordinate 内部排序固定，两种调用顺序得到相同结果', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    rt.registerType('k', {
      load: async (id) => ({ id, bal: 0 }),
      save: async () => {},
      persist: 'writeThrough',
    });
    const runAB = async () =>
      coordinate(
        rt,
        { type: 'k', id: 'A' },
        { type: 'k', id: 'B' },
        async (a: any, b: any) => {
          a.bal += 1;
          b.bal += 2;
          rt.markDirty();
        },
      );
    const runBA = async () =>
      coordinate(
        rt,
        { type: 'k', id: 'B' },
        { type: 'k', id: 'A' },
        async (a: any, b: any) => {
          a.bal += 1;
          b.bal += 2;
          rt.markDirty();
        },
      );
    await runAB();
    await runBA();
    expect((rt.peek('k', 'A') as any).bal).toBe(3);
    expect((rt.peek('k', 'B') as any).bal).toBe(3);
  });
});
