# 玩家状态写入口架构（Actor 式单写者）

> 目标：彻底根治「旧快照整包覆盖」与「CAS 并发冲突（玩家数据并发冲突，请重试）」类事故。
> 设计参照：Orleans / Erlang OTP 的 Serialized Single-Writer 思路——玩家状态唯一归属，
> 所有修改经同一把用户级锁串行化、复用唯一快照、由最外层统一落库。

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

1. **串行**：全程持 `PlayerService.withUserLock(userId, …)`（进程内按 userId 的 Promise 闸门锁，
   ALS 重入标记支持嵌套自调用），与战斗、后台结算、其它指令天然互斥。
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

| 路径 | 是否持锁 | 状态 |
| --- | --- | --- |
| 指令 handler（网页 / AstrBot / API） | `mutate` → `withUserLock` | ✅ 统一快照 + 统一落库 |
| `AutoMineService.checkpoint/settle`（每分钟 cron） | `withUserLock` | ✅ 与指令互斥 |
| `GameService.settleGatherResource`（进程内定时器 + 每5秒兜底） | `withUserLock` | ✅ 与指令互斥 |
| `CombatSystemService.weaponAttack`（含自动战斗 tick） | `withUserLock` | ✅ 与指令互斥 |

注意：`settleGatherResource` 中段依赖 `savePlayer` 的**整包 CAS 认领**「采集中」标记来防止双结算，
刻意保持真实落库（不并入 merge 安全网），且已持锁——这是有意为之，勿将其也并入 merge。

`ScheduleService` 中 `settlePendingMoves` / `cleanupExpiredBuffs` 走 `prisma.player.update` 直接定点
更新（字段级、无 version CAS），属低优先级的既有残留路径：不会造成「整包覆盖」或「并发冲突」，
仅理论上可能覆盖并发 mutate 刚写过的同一字段。如需完全单写者统一，后续可在锁内重读后再写。

## 5. 测试护栏

- `test/architecture-guard.spec.ts`：`RAW_SAVEPLAYER_BASELINE` / `MUTATE_CALL_BASELINE` 单向度量，
  把架构约束固化进测试，避免规范随重构丢失。
- `test/player-mutate.spec.ts`：单一快照复用、货币审计、嵌套 mutate、addExp 复用、以及
  3.1 的「内层 savePlayer 合并而非二次落库」回归。
- 全量单测（排除 integration）：约 540/541 通过。唯一失败为 `onboarding-flow`（真实远程库 e2e），
  卡在教程文案内容断言（环境相关），与并发修复无关。
