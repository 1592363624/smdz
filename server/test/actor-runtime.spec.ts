/**
 * Actor 运行时单元测试
 *
 * 目标：验证「单进程内、每实体一个串行邮箱 + 内存态 + 异步落库」的核心不变量：
 *  1. 同实体写操作严格串行（单时刻一条，无 interleaving）—— 无锁无 CAS 的并发正确性基础
 *  2. 内存态单激活（并发 run 只 load 一次；peek 命中同一对象引用）
 *  3. writeThrough 策略：写后立刻落库
 *  4. deferred 策略 + deactivate：仅标脏，停用/周期才落库
 *  5. 跨实体协调者（coordinate）：按稳定键字典序确定性排序，打破 A↔B 死锁环路
 *  6. LRU 驱逐：超过容量上限时按最久未用驱逐（脏 cell 先落库）
 *
 * 不依赖 Nest DI：直接 new ActorRuntime（构造仅接收配置，无需容器）。
 */

import { ActorRuntime } from '../src/modules/actor';
import { coordinate } from '../src/modules/actor';

function inMemoryType(backing: Record<string, any>) {
  let loadCalls = 0;
  const cfg = {
    load: async (id: string | number) => {
      loadCalls++;
      const v = backing[String(id)];
      if (v === undefined) throw new Error(`no such entity: ${id}`);
      return JSON.parse(JSON.stringify(v));
    },
    save: async (id: string | number, state: any) => {
      backing[String(id)] = JSON.parse(JSON.stringify(state));
    },
    persist: 'writeThrough' as const,
  };
  return { cfg, getLoadCalls: () => loadCalls };
}

describe('ActorRuntime 核心不变量', () => {
  it('同 key 的 run 严格串行执行，无 interleaving', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType({ x: { n: 0 } });
    rt.registerType('k', cfg);
    const events: string[] = [];
    const p1 = rt.run('k', 'x', async (s: any) => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      s.n += 1;
      events.push('a-end');
      return s.n;
    });
    const p2 = rt.run('k', 'x', async (s: any) => {
      events.push('b-start');
      s.n += 1;
      events.push('b-end');
      return s.n;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it('并发 run 只激活（load）一次，且 peek 命中同一对象引用', async () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg, getLoadCalls } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    await Promise.all([
      rt.run('k', 'x', async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
      rt.run('k', 'x', async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
    ]);
    expect(getLoadCalls()).toBe(1);
    const a = rt.peek('k', 'x');
    const b = rt.peek('k', 'x');
    expect(a).toBeDefined();
    expect(a).toBe(b); // 同一内存态引用
    expect((a as any).v).toBe(1);
  });

  it('writeThrough：写后立刻落库到后端存储', async () => {
    const backing: Record<string, any> = { x: { v: 5 } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType(backing);
    rt.registerType('k', cfg);
    await rt.run('k', 'x', async (s: any) => {
      s.v = 99;
    });
    expect(backing.x.v).toBe(99);
  });

  it('deferred + deactivate：写后不立即落库，停用才落库并清内存', async () => {
    const backing: Record<string, any> = { x: { v: 1 } };
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType(backing);
    rt.registerType('k', { ...cfg, persist: 'deferred' });
    await rt.run('k', 'x', async (s: any) => {
      s.v = 42;
    });
    expect(backing.x.v).toBe(1); // 尚未落库
    await rt.deactivate('k', 'x');
    expect(backing.x.v).toBe(42); // 停用触发落库
    expect(rt.peek('k', 'x')).toBeUndefined(); // 内存已移除
  });

  it('未激活的 peek 返回 undefined（不会触发 load）', () => {
    const rt = new ActorRuntime({ flushIntervalMs: 0 });
    const { cfg } = inMemoryType({ x: { v: 1 } });
    rt.registerType('k', cfg);
    expect(rt.peek('k', 'x')).toBeUndefined();
  });

  it('LRU 驱逐：超过 lruMax 时按最久未用淘汰（非脏 cell 直接移除）', async () => {
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

    // A→B 转 10，B→A 转 10：两笔并发，若各自持锁等对方会死锁。
    // coordinate 内部始终按字典序（A 先于 B）获取邮箱，环路被打破。
    async function transfer(from: string, to: string) {
      await coordinate(
        rt,
        { type: 'k', id: from },
        { type: 'k', id: to },
        async (a: any, b: any) => {
          a.bal -= 10;
          b.bal += 10;
        },
      );
    }

    await Promise.all([transfer('A', 'B'), transfer('B', 'A')]);

    const pa = rt.peek('k', 'A') as any;
    const pb = rt.peek('k', 'B') as any;
    // 两笔各转 10：A-10+10、B+10-10，净变化 0
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
          a.bal += 1; // 第一个参数永远是 A
          b.bal += 2; // 第二个参数永远是 B
        },
      );
    const runBA = async () =>
      coordinate(
        rt,
        { type: 'k', id: 'B' },
        { type: 'k', id: 'A' },
        async (a: any, b: any) => {
          a.bal += 1; // 第一个参数永远是传入的 from（B）
          b.bal += 2; // 第二个参数永远是传入的 to（A）
        },
      );
    await runAB();
    await runBA();
    // runAB: A+=1,B+=2 ; runBA: B+=1,A+=2 => A=3,B=3
    expect((rt.peek('k', 'A') as any).bal).toBe(3);
    expect((rt.peek('k', 'B') as any).bal).toBe(3);
  });
});
