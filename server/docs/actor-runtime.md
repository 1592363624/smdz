# 通用 Actor 运行时（单进程内、全部有状态实体）

> 适用范围：玩家、怪物、地图、载具、商店物品等**一切有独立状态表的实体**。
> 设计目标：把「理想 Actor 模型」的单进程形态落地——每个实体一个串行邮箱 + 私有内存态 +
> 单激活 + 异步落库，**单进程内天然无锁、无 CAS、无整包覆盖**。

## 1. 为什么需要它

「使魔大战3」是高度并发的异步游戏：战斗 tick、自动开采、后台结算、玩家指令、公会/交易
等写路径会并发修改同一份实体状态。过去的状态事故（旧快照整包覆盖、乐观锁 P2025 并发冲突、
召唤券蒸发）根因都是「多份快照并发写回」。

纯 Actor 模型从设计上消灭数据竞争：

- 把每个实体（玩家、怪物、地图…）封装成独立的 **Actor**，键为稳定的 `type:id`。
- 每个 Actor 有**私有内存态**和**消息邮箱**，所有发给它的消息**串行排队执行**，
  同一时刻只处理一条（靠 per-key 的 **Promise 链**保证，不是 Mutex）。
- 状态只归 Actor 自己修改；外部通过 `run / tell / ask` 发消息，不直接碰状态。
- **单进程内单激活**：同一 `type:id` 在进程内只有一个 cell（`Map` 唯一键），
  天然不会有第二个执行体同时读写它。

因此不需要锁、不需要乐观锁 CAS——串行化由 Promise 链完成。

## 2. 模块布局

| 文件 | 职责 |
| --- | --- |
| `src/modules/actor/types.ts` | 类型定义：`EntityType` / `EntityId` / `actorKey(type,id)='type:id'` / `PersistPolicy` / `ActorTypeConfig`（load/save/initState?/persist?） |
| `src/modules/actor/actor-runtime.ts` | 核心运行时 `ActorRuntime`：`Map<key, ActorCell>` + per-key Promise 邮箱 + ALS 重入 + LRU 驱逐 + 周期落库 |
| `src/modules/actor/coordinator.ts` | 跨实体协调者 `coordinate` / `coordinateMany`：按 `actorKey` 字典序确定性排序获取邮箱，打破 A↔B 死锁环路 |
| `src/modules/actor/builtin-types.ts` | `registerBuiltinActorTypes(runtime, prisma)`：注册 monster / map / vehicle / shopitem 四种实体 |
| `src/modules/actor/actor.module.ts` | Nest 模块：提供 `@Global` 的 `ActorRuntime` 单例，`onModuleInit` 时调用 `registerBuiltinActorTypes` |
| `src/modules/game/player.service.ts` | 玩家自己注册 `'player'` 类型（复用 getPlayerData / savePlayer 的归一化逻辑），`enqueueUserWrite` 委托运行时 |

### 2.1 ActorCell（每个实体的运行时态）

```ts
interface ActorCell<S = any> {
  key: string;            // 'type:id'
  type: EntityType;
  id: EntityId;
  state: S | undefined;   // 内存态；未激活时为 undefined
  dirty: boolean;         // 是否被改、待落库
  activating: Promise<void> | null; // 并发 run 时的 load 去重
  mailbox: Promise<unknown>;        // 串行邮箱链尾
  pending: number;       // 在途任务数（背压用，见 §9）
  lastUsed: number;                // 用于 LRU
}
```

## 3. 写入口语义

### 3.1 `run(type, id, fn)` —— 单一写入口

```ts
const result = await actorRuntime.run('monster', monsterId, async (state) => {
  state.hp -= damage;        // 直接改内存态
  return state.hp;           // 返回值即 run 的返回值
});
```

执行流程：

1. **重入识别**：若当前异步链已在同 `type:id` 的 Actor 内（ALS 上下文），直接执行 `fn(state)`，
   不重复排队——避免跨实体协调者嵌套调用或 A→B→A 自死锁。
2. **串行排队**：把本次任务挂到该实体邮箱链尾，等前一个任务完成再执行
   （`prev.then(...)`）。这就是「单时刻一条」的保证，全靠 Promise 链，无 `Mutex`/`lock`。
3. **激活**：`state === undefined` 时调 `config.load(id)` 把存储态载入内存（并发 run 通过
   `activating` Promise 去重，只 load 一次）。
4. **执行** `fn(state)`。
5. **按策略落库**：
   - `writeThrough`：每次写后立刻 `config.save(id, state)` 落库，`dirty` 清零
     （等价于原 `savePlayer` 行为，最安全）。
   - `deferred`：仅置 `dirty`，交给周期落库 / 停用 / LRU 驱逐统一落库（真正的异步批量）。

`run` 是「单一写入口」：邮箱内写操作执行后按策略落库，调用方无需自行标脏也能保证持久化。
（保留 `markDirty()` 供「拿到 `peek` 引用后在 run 之外改」的场景显式标脏。）

### 3.2 `tell` / `ask` —— 消息式

- `tell(type, id, handler)`：发消息、不取返回值。
- `ask<R>(type, id, handler)`：发消息并返回 `handler(state)` 的结果。

二者都是 `run` 的语义等价物；`run` 闭包更省事，是主路径。

### 3.3 `peek` —— 只读命中缓存

```ts
const cached = actorRuntime.peek('player', userId); // 已在内存则返回同一引用，否则 undefined
```

仅当实体 Actor 已激活（内存态存在）时返回，不触发 load。适合「读已有缓存」的热路径
（`PlayerService.getPlayerData` 即优先走 `peek`，命中即返回，省一次打库）。

## 4. 持久化策略（PersistPolicy）

| 策略 | 时机 | 适用 |
| --- | --- | --- |
| `writeThrough` | 每次 `run` 写后立刻落库 | 默认；行为等同于旧 savePlayer，零数据丢失风险 |
| `deferred` | 仅标脏，周期（`flushIdle`）/ 停用（`deactivate`）/ LRU 驱逐时落库 | 高频写、可容忍秒级延迟，最大化吞吐 |

`ActorRuntime` 构造可配：

- `lruMax`（默认 2000）：内存中最多保留多少 cell，超出按 LRU 驱逐。
- `flushIntervalMs`（默认 5000）：周期落库间隔，0 关闭定时器。
- `idleEvictMs`（默认 30000）：周期落库时，空闲超过该时长的脏 cell 落库并驱逐。

退出：实现 `OnModuleDestroy`，`onModuleDestroy` 先 `clearInterval` 再 `flushAll()`，保证进程优雅退出不丢脏数据。

## 5. 跨实体协调者（防死锁）

纯单 Actor 的死穴是**两个 Actor 互相依赖**的场景：交易（A 扣钻 B 加钻）、公会银行、
战斗同时改攻防双方。若「A 持锁等 B、B 持锁等 A」就会死锁。

`coordinate(runtime, keyA, keyB, fn)` 用「按稳定键 `actorKey` 字典序**确定性排序**获取邮箱」
打破环路：无论调用方以何种顺序传入 `keyA/keyB`，内部永远先拿字典序较小的那一个，再拿较大的，
任何调用方拿锁顺序都一致，环路被破除。`coordinateMany` 对一组实体做同样处理，适用于
公会银行、拍卖行等多方写。

```ts
// 任意顺序调用都不会死锁，且最终余额一致
await coordinate(rt, {type:'player',id:'A'}, {type:'player',id:'B'},
  async (a, b) => { a.diamond -= 10; b.diamond += 10; });
```

嵌套安全：`run` 内再 `run` 同一实体走 ALS 重入路径，不会自死锁。

## 6. 已注册的实体类型

| type | 注册方 | load / save | 策略 |
| --- | --- | --- | --- |
| `player`  | `PlayerService.onModuleInit` | `getPlayerData` / `persistPlayer`（复用货币列化、标记归一化、BigInt 转换） | `writeThrough` |
| `monster` | `registerBuiltinActorTypes` | `prisma.gameMonster.findUnique` / 整行 `update`（去除 `createdAt`） | `writeThrough` |
| `map`     | 同上 | `prisma.gameMap` | `writeThrough` |
| `vehicle` | 同上 | `prisma.gameVehicle` | `writeThrough` |
| `shopitem`| 同上 | `prisma.gameShopItem` | `writeThrough` |

> 说明：NPC 无独立表（嵌在 `GameMap.monsters/npcs` JSON 内），公会/副本（Guild/Dungeon）
> 也无独立状态表（嵌在 `Player` JSON 内）。因此它们被各自「宿主实体 Actor」（map / player）
> 的序列化状态覆盖，无需单独注册。需要独立事务一致性的调用点，可用 `coordinate` 跨宿主实体
> 做原子操作。

## 7. 边界与后续

- **单进程保证**：本运行时只保证**单进程内**串行。水平扩容时同一实体落到不同实例会打破保证。
  届时需在前面加「玩家/实体亲和路由」，或把 per-key 邮箱换成分布式邮箱（如 Redis 队列）。
  运行时已预留 `type + id` 稳定键，便于未来接入分布式邮箱。
- **BigInt / JSON**：内存储态直接持有 Prisma 行对象；`save` 时去掉 `createdAt` 后整行 `update`，
  Prisma 的 `BigInt` 列接受 `number`，精度无损。
- **接入方式**：游戏内具体调用点（如战斗结算怪物 HP、地图事件）迁移到 `runtime.run('monster', …)`
  是后续按调用点的渐进式改造；本步先把「实体即 Actor」的框架能力铺好。

## 8. 测试

- `test/actor-runtime.spec.ts`：覆盖串行执行 / 单激活 / peek 缓存命中 / writeThrough 即时落库 /
  deferred + deactivate 落库 / 未激活 peek 返回 undefined / LRU 驱逐 / coordinate 防死锁与确定性。

## 9. 健壮性加固（2026-08-30）

在「理想 Actor 模型」骨架上补齐生产级健壮性，全部在 `actor-runtime.ts` 内实现，无外部依赖。

### 9.1 背压（mailboxMaxDepth → ActorMailboxOverflowError）

单实体邮箱积压超过 `mailboxMaxDepth`（默认 1000）时，后续入队任务直接抛 `ActorMailboxOverflowError`，
避免 Promise 链无限增长拖垮进程。调用方可捕获后降级（如「操作过于频繁，请稍后再试」）或入分布式队列。
计数 `totalOverflow` 进 `stats()`。

### 9.2 可观测性（ActorRuntimeStats）

`stats()` 返回运行时快照：`cells / byType / pending / totalPersists / totalEvictions /
totalErrors / totalOverflow / mailboxDepthMax`。压测与运维可据此判断热点实体、落库压力、错误率。

### 9.3 错误丢弃（all-or-nothing）

`run` 内 `fn` 抛错时，`withActivated` 把 `cell.state = undefined`、`dirty = false`、`activating = null`，
**丢弃本次（可能半改的）内存态**，并 `totalErrors++` 后向上冒泡错误。下次 run 重新从库 `load` 干净状态，
避免半截改动被后续写落库污染 DB，也避免陈旧内存态被复用（正确性风险 #5 的兜底）。

### 9.4 懒落库（persist-on-dirty）

`run` 成功返回后按策略落库，**仅当 `cell.dirty` 为真**才写：`writeThrough` 才 `config.save` 并清零
`dirty`；`deferred` 保留 `dirty` 待后台刷盘。纯只读 run 不再白吞一次 DB 写（性能修复）。
业务在邮箱内改完状态须显式标脏——`savePlayer`（Actor 内）调 `markDirty()` 或
`PlayerService.markPlayerDirty(userId)`（架构门禁友好、不新增裸 `savePlayer` 调用点）触发落库。

### 9.5 缓存失效（stale-cache invalidate）

`invalidate(type, id)` 删除内存 cell。供「不走 Actor 邮箱的直接写」（如大量现存 `savePlayer` 调用点）
落库后调用，避免内存缓存陈旧、被后续 `enqueueUserWrite` 复用并覆盖本次落库结果（正确性，见
`PlayerService.getPlayerData` 注释：`getPlayerData` 在非 Actor 读取一律走 DB，不返回缓存 cell）。

### 9.6 空闲回收（LRU 兼收脏净）

`flushIdle`（周期 `flushIntervalMs`，默认 5000ms）遍历 cell：空闲超过 `idleEvictMs`（默认 30000ms）
者，无论脏净都先落库（若脏）再驱逐——干净空闲 cell 不再长期占内存（健壮性缺口修复）。
`evictIfNeeded` 在容量超 `lruMax`（默认 2000）时按 LRU 驱逐，脏 cell 先落库。
进程退出 `onModuleDestroy` 先 `clearInterval` 再 `flushAll()`，保证优雅退出不丢脏数据。

### 9.7 玩家写入口的双表示调和（markers 并集合并）

`getPlayerData` 同时暴露「顶层解析对象 `data.markers`」与「行字符串 `player.markers`」两套表示
（`__actorBase` 记录载入基线）。同一 run 内不同子系统可能分别改两套表示（如 `selectFamiliar` 改顶层
加「伊卡洛斯好感」、`ensureTutorialTasks` 改行字符串加「教程」），落库时若「选其一」必丢另一侧重的新键。
`persistPlayerData` 对 `markers`（扁平 key→值对象）做**按 key 并集合并**：仅顶层变的 key 取顶层、
仅行变的 key 取行、两侧都变的取顶层实时态，任一方的改动都不丢失（见
`docs/player-state-architecture.md` §3.3）。数组类字段（backpack/buffs/tasks…）保持「顶层解析数组优先」，
因其改动是累积 push、行字符串改写只是上一次落库的副产物。
