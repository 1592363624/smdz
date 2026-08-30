# 玩家状态写入口架构（纯 Actor 单写者：无锁、无 CAS）

> 目标：彻底根治「旧快照整包覆盖」与「乐观锁 CAS 并发冲突（玩家数据并发冲突，请重试）」类事故。
> 设计参照：Orleans / Erlang OTP 的 Serialized Single-Writer 思路——玩家状态唯一归属，
> 所有修改只能经同一玩家的「串行邮箱（Actor 收件箱）」发消息、内部单线程顺序执行、天然无竞态。
> **关键纠正（2026-08-30）**：此前命名为 `withUserLock` 实为误导——它根本不是互斥锁，而是
> `enqueueUserWrite` 这条 per-user 的 Promise 链；且 `savePlayer` 已移除 `(id,version)` CAS 冲突判定，
> 不再抛「并发冲突」。version 仅由 Prisma `$use` 中间件自增，供审计/增量重放。

## 1. 问题根因

玩家背包 / 标记 / 装备等复杂结构以 JSON 字符串整包存取。历史上任何「读取快照 → 修改 →
整包写回」的路径如果与另一条路径**并发**执行，后写者会用自己读到的**旧快照**覆盖先写者的改动：

- 曾导致「兑换扣钻后，后台自动开采结算用旧快照把召唤券回滚蒸发」。
- 或快照版本过期触发乐观锁 `(id, version)` 条件更新失败（P2025）→ 转「玩家数据并发冲突，请重试」。

## 2. 设计：基础设施层安全网 + 单点收口

不逐个改写 217 处裸写 `savePlayer`，而是让写入口自身「上下文感知」，再把唯一指令漏斗用
`mutate` 包一层——所有命令路径自动纳入同一快照。

### 2.1 `mutate(userId, fn)` —— 玩家状态的唯一推荐入口

位于 `PlayerMutateService`，保证三件事：

1. **串行**：全程经 `PlayerService.enqueueUserWrite(userId, …)`（进程内按 userId 的 Promise 串行链，
   **非互斥锁**——即 Actor 收件箱：同用户写操作串到前一个之后顺序执行、单线程天然无竞态；ALS 重入
   标记支持嵌套自调用，避免 A→B→A 自死锁），与战斗、后台结算、其它指令天然互斥。
2. **单一快照**：一条业务链只读取一份快照，嵌套调用（同一 userId 的 `mutate` / 直接 `savePlayer`）
   复用它（`currentFor`），不再重读库。
3. **统一落库**：只有最外层负责 `savePlayer` 落库与货币审计；内层改动自动合并回上下文。

### 2.2 安全网：`getPlayerData` / `savePlayer` 上下文感知

- `getPlayerData(userId)`：若当前异步链已在某玩家的 `mutate` 内，直接返回登记的 `ctx` 快照，
  不再重读库、不再重解析（避免派生第二份数据整包覆盖外层）。
- `savePlayer(player)`：若当前链已在 `mutate` 内，把本次保存对象上**显式出现的字段**
  （经 `mergeIntoMutateContext` 只合并出现过的字段，避免局部对象覆盖整包）合并回 `ctx`，
  置脏并返回——真正的落库交给最外层。外层用 `fieldSignature` 自动侦测 ctx 是否被改
  （含「纯改 ctx 未显式 savePlayer」的写法），有改动才统一 CAS 落库，纯只读指令跳过。

### 2.3 单点收口：`CommandService.executeDispatch`

所有来源（网页 / AstrBot / API）的指令都经 `handler.handle(ctx, args)`，已在 `executeDispatch`
中用 `playerMutate.mutate(ctx.userId, …)` 包裹。game / familiar / combat 等全部裸写自动复用
唯一快照、由最外层统一落库。

## 3. 关键修正（2026-08-30）

### 3.1 反查键 bug（最核心）

`safety net` 反查上下文时，`savePlayer` 旧代码用 `currentFor(player.id)`，但 `mutate` 把 `ctx`
登记在 **`userId`** 下（`Player.id` 是自增主键、`Player.userId` 是独立 `@unique` 字段，二者不同）。
于是「在 mutate 内调用 savePlayer」**命中不到 ctx** → 内层 savePlayer 真的写一次库、再 bump 一次
version，外层保存又以过期版本 CAS → 双写 / 版本分叉 → 并发冲突。这正是反复出现的根因。

修正：

- `PlayerMutateContextService.run` 在登记 `userId` 的同时，按 `ctx.player.id` 也登记一份
  （外层统一收口在 `run` 作用域结束后才触发，届时 ALS 已还原，不会误判为「仍在 mutate 内」）。
- `PlayerService.savePlayer` 反查键改为 `resolveMutateKey(player)`：优先 `player.userId`，
  回退 `player.id`，命中即合并回上下文。

> 回归测试见 `test/player-mutate.spec.ts`「mutate 内业务方直接调用 savePlayer 应合并回上下文而非
> 二次落库」：临时回退该修正可复现 `prisma.update` 被调用两次（version 0→1、1→2）。

### 3.2 BigInt 序列化崩溃

`lastOpTime` / `readTime` 等为 schema `BigInt` 列。`getPlayerData` 读侧统一把玩家对象上的
`BigInt` 属性转 `Number`（Prisma 写 `BigInt` 列同样接受 `number`，精度无损），避免 `pushState`
等 JSON 序列化路径抛「Do not know how to serialize a BigInt」。

## 4. 覆盖矩阵（彻底根治后的写入口）

| 路径 | 是否串行化（邮箱） | 状态 |
| --- | --- | --- |
| 指令 handler（网页 / AstrBot / API） | `mutate` → `enqueueUserWrite` | ✅ 统一快照 + 统一落库 |
| `AutoMineService.checkpoint/settle`（每分钟 cron） | `enqueueUserWrite` | ✅ 与指令互斥 |
| `GameService.settleGatherResource`（进程内定时器 + 每5秒兜底） | `enqueueUserWrite` | ✅ 与指令互斥 |
| `CombatSystemService.weaponAttack`（含自动战斗 tick） | `enqueueUserWrite` | ✅ 与指令互斥 |
| `ScheduleService.settlePendingMoves` / `cleanupExpiredBuffs`（定时器） | `enqueueUserWrite` → `savePlayer` | ✅ 已收口，单写者统一 |

注意：`settleGatherResource` 中段依赖 `savePlayer` 的**整包认领**「采集中」标记来防止双结算，
该认领依托串行邮箱互斥（同用户写顺序执行，不会并发改写同一标记），不再依赖 version CAS；
刻意保持真实落库（不并入 merge 安全网），且已入邮箱——这是有意为之，勿将其也并入 merge。

`ScheduleService` 中 `settlePendingMoves` / `cleanupExpiredBuffs` 已收口：原先走 `prisma.player.update`
直接定点更新（绕过指令漏斗），现改为 `enqueueUserWrite(userId, async () => { 重读最新快照 → 改 →
savePlayer })`，与指令、后台结算共享同一串行邮箱，达成全量单写者统一、无整包覆盖、无并发冲突。

## 5. 测试护栏

- `test/architecture-guard.spec.ts`：`RAW_SAVEPLAYER_BASELINE = 219` / `MUTATE_CALL_BASELINE = 4`
  单向度量（裸写只增基线、mutate 只增不减；基线 217→219 来自 ScheduleService 两条定时器写经
  串行邮箱合规收口为 `savePlayer`），把架构约束固化进测试，避免规范随重构丢失。
- `test/player-mutate.spec.ts`：单一快照复用、货币审计、嵌套 mutate、addExp 复用、以及
  3.1 的「内层 savePlayer 合并而非二次落库」回归。
- 全量单测（排除 integration）：540/541 通过。唯一失败为 `onboarding-flow`（真实远程库 e2e），
  卡在教程文案内容断言（环境相关），与并发修复无关。注：`exp-normalize` / `save-player-cas` 的
  Prisma 桩已同步改为模拟 `$use` 中间件自增 version（不再模拟旧 CAS），`architecture-guard`
  基线 217→219。

## 6. 通用 Actor 运行时（单进程内、全部有状态实体）

玩家的 `enqueueUserWrite` 串行邮箱只是「每实体一个 Actor」在玩家身上的特例。现已将其泛化为
**通用 Actor 运行时**：玩家 / 怪物 / 地图 / 载具 / 商店物品等一切有独立状态表的实体，都注册成
`type:id` 唯一键的 Actor，统一享有「私有内存态 + 串行邮箱 + 单激活 + 异步落库」。

- 玩家由 `PlayerService.onModuleInit` 注册 `'player'`（复用 `getPlayerData` / `persistPlayer`），
  且 `enqueueUserWrite` 直接委托 `actorRuntime.run('player', userId, …)`。
- 怪物/地图/载具/商店物品由 `registerBuiltinActorTypes(runtime, prisma)` 在
  `ActorModule.onModuleInit` 时注册（见 `src/modules/actor/actor.module.ts`）。
- `ActorRuntime` 作为 `@Global` 单例提供，任意服务可直接注入并通过 `run / tell / ask / coordinate`
  以纯 Actor 语义访问任意实体；`PersistPolicy` 支持 `writeThrough`（每次写后落库）与 `deferred`
  （仅标脏、周期/停用/驱逐落库）；`coordinate` 用字典序确定性排序打破跨实体死锁环路。
- 串行化仍靠 **Promise 链（非 Mutex）**，因此**无锁、无 CAS**；version 仅由 `$use` 中间件自增
  供审计/增量重放，不在 Actor 层做冲突判定。

> 完整设计、模块布局、生命周期、跨实体协调者与边界见 **`docs/actor-runtime.md`**。
> 单元测试见 `test/actor-runtime.spec.ts`（串行执行 / 单激活 / peek 缓存命中 / 策略落库 /
> LRU 驱逐 / coordinate 防死锁）。
