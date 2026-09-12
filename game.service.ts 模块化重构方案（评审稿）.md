# 使魔大战 3・game.service.ts 模块化重构方案（评审稿）

> 状态：**已评审通过（2026-09-12 定案，决策记录见文末）— 可按 §5 从 P0 进入实施**
>
> **尚未改动任何业务代码**（本方案全部结论来自只读分析）
>
> 扫描基线：2026-09-11 初稿 / **2026-09-12 复核**（HEAD `b1bb5cc` 后复测，个别数字已漂移，见文中标注）
>
> 目标文件：`server/src/modules/game/game.service.ts` — **17,413 行（09-12 复测）/ 427 个方法**
>
> 分析工具：`server/scripts/analyze-god-service.js`、`analyze-call-graph.js`、`analyze-scc-layers.js`
>
> 前置文档：《命名与术语优化方案》（术语口径以该文为准，本方案不重复定义）

---

## 0. 总体结论

1. **不重构的代价已被实证，不是「只是代码长」。** 已产生 6 类可量化缺陷：双实现漂移、单一真相源被绕过、循环加载崩溃风险、测试构造脆弱、修改收敛瓶颈、门禁只位移矛盾（详见 §1）。
2. **重构可行，但不能"一组一服务"式硬拆。** 组级依赖图实测：20 个组中 **14 个落在 2 个强连通分量（SCC）内**，朴素拆分必然触发 Nest 循环依赖。
3. **关键路径是先把"共享支撑层"抽出来。** 该层被 **18 个组共调用 114 次**；抽出后 SCC 数量与残环规模显著下降（§3.4）。
4. **必须保留 `GameService` 作为委托门面。** 外部调用面实测 **约 420 处**：`GameCommandHandler`（约 200 处）+ 45 个测试套件（173 个方法直调，**含私有方法**）+ `game.controller`（11 方法）+ `command.service`（10 方法）+ 其余 15 个 `command/handlers/*.handler.ts`（每文件 1~2 处）+ `chat.gateway`（3 处）+ `schedule.service`（`buildMerchantInventory`）+ `game-sync/sync-projector.service`（**经 `forwardRef` 注入门面，调用 `pushPlayerUpdate`/`pushMapUpdate`**）。且门面构造器用 **29 个参数**构造（23 必选 + 6 个尾部 `@Optional`，既有测试以位置传参 / `Object.create` 两种方式构造）。因此**门面必须保留全部 427 个方法的同名委托（含私有辅助）**，并额外承载构造器接线与推送子系统（见 §4.2/§4.3 的"非纯委托例外"）。
5. **建议分 5 批执行（P0~P4）**，每批独立验证、逐批下调门禁基线，期间不冻结需求。
6. **测试桩是本次重构最大的隐性回归面。** 45 个 spec 中 **28 个用 `Object.create(GameService.prototype)` 跳过构造器构造桩**，再手工挂依赖字段。方法迁出后，这些桩调用原方法会命中门面委托体，而委托目标子服务字段为 `undefined` → **TypeError 级大面积失败**。必须先建测试工厂并逐批修复（§5 P1-6、风险 R8）。
7. **巨型文件不止这一个。** 全库扫描（§11）：`combat-system.service.ts` **12,418 行 / 186 方法**（第二个上帝文件）、`familiar-system` 4,853、`familiar-skills` 4,053、`item-system` 3,386。且跨文件统一出口被普遍绕过：裸 `savePlayer` 在 game.service 之外仍有 **约 162 处**，`displayDamage` 双实现逐字符相同，时长格式化辅助已扩散至第 7 个。本方案（§0~§10）只解决 game.service 一期；§11 登记二期范围与止损门禁，**不在本次实施**。

---

## 1. 诊断：为什么必须做（证据）

### 1.1 规模与增速

| 指标 | 实测值 |
|---|---|
| 当前行数 / 方法数 | **17,413 行**（09-12 复测，初稿为 17,419）/ 427 个（240 个 `handleXxx` + 238 个私有辅助） |
| 30 天增速 | 5,068 行（08-12）→ 17,413 行（09-12），**+244%** |
| 提交占比 | 267 次提交中 **139 次（52%）** 修改此文件 |
| 门禁基线 | `GAME_SERVICE_LINE_BASELINE = 17434`（只减不增，`test/architecture-guard.spec.ts` L473） |

### 1.2 六类实质缺陷

| # | 缺陷 | 实测证据 | 危害 |
|---|---|---|---|
| 1 | **双实现漂移** | `round2Text`(L3521) 与 `roundText`(L16969) **实现体高度重合**，相隔 13,448 行；同文件内并行维护 **6 个时长处理辅助** | 改一处漏另一处 → 展示口径分裂 |
| 2 | **单一真相源被绕过** | 内联品质映射 **20 处**（应走 `equipmentQualityLabel`）；手写秒/毫秒启发式 **3 处**（应走 `expire-time.util`）；手写两位小数 **2 处**（应走 `roundItemQuantity`）；手写 `backpack.push` **2 处**（应走 `mergeBackpackItem`） | **已真实引爆过**：苇名剑法 60s → 16.7h |
| 3 | **循环加载崩溃风险** | `service-tokens.ts` 两处字符串 token 别名，专为规避 CommonJS 循环加载导致的 `AFFIX_TO_BONUS` 半初始化**运行时崩溃**（有测试实证）；game 模块 **45 处 `@Optional`** 变通 | 改一行 `import` 即可能在启动期崩溃 |
| 4 | **测试构造脆弱** | 45 个 spec 引用 `GameService`，**173 个方法被直接调用（含私有辅助）**；其中 **28 个 spec 用 `Object.create(GameService.prototype)` 跳过构造器**手工挂依赖，其余用 **29 个位置参数**构造（23 必选 + 6 `@Optional`，初稿期早年报为 23/17，已漂移） | 构造器增删/换序或方法迁出 → 大面积静默错位或 TypeError（详见 R8） |
| 5 | **修改收敛瓶颈** | 52% 的提交竞争同一文件 | 并行开发必然冲突；评审无法穷尽上下文 |
| 6 | **门禁只位移矛盾** | 行数冻结后膨胀转移至 `game-command.handler.ts`：1,009 行（08-13）→ **2,041 行**（09-11） | 问题被搬走而非解决；且该文件无门禁约束 |

### 1.3 同时存在的写模型债务集中

| 指标 | 实测值 |
|---|---|
| 裸 `savePlayer` 调用（本文件） | **114 处**，占全项目 276 基线的 **41%** |
| `getPlayerData` 直读（本文件） | **151 处** |

### 1.4 诚实边界：以下**不是**问题

- 全量构建 **15.4s**；`game.service.js` 产物 **676KB** — 构建不是瓶颈。
- `Math.sqrt` **0 处** — 怪物等级口径未被污染。
- 单元测试 **1101 通过 / 5 失败** — 功能面基本健康。

上述 6 类缺陷均属**"下一次改动时引爆"的复利型技术债**，不是当下正在流血。但在"仍要大量新增功能"的前提下，第 1/2/4/5 项会以每次新增指令为单位持续复利。

---

## 2. 硬约束（决定方案形态，不可违反）

| # | 约束 | 来源 | 对方案的影响 |
|---|---|---|---|
| C1 | **约 420 处外部调用点不可动** | `GameCommandHandler`（约 200 处）+ 45 个 spec（173 方法，**含私有辅助直调**）+ `game.controller`(11) + `command.service`(10) + 15 个独立 handler + `chat.gateway`(3) + `schedule.service`(1) + `sync-projector.service`（经 forwardRef 调 `pushPlayerUpdate`/`pushMapUpdate`） | `GameService` 必须保留**全部 427 个方法**的同名委托（**含私有辅助**——迁移期间未迁移代码的 `this.xxx()` 也要经门面触达已迁移实现），方法体改为一句话委托 |
| C2 | **新增依赖注入必须 `@Optional` 且置于构造器末尾** | 测试用两种方式构造：位置传参（现 29 实参，23 必选 + 6 尾部可选）或 `Object.create` 跳过构造器（28 个 spec） | 新子服务只能追加到构造器尾部；`Object.create` 桩天然拿不到新依赖 → 必须配套测试工厂（§5 P1-6） |
| C3 | **组间存在真实循环（14/20 组在 SCC 内）** | 调用图实测（§3） | 必须"支撑层断边 + `forwardRef` 兜底 + 必要时聚类合并"三措并举 |
| C4 | **架构门禁会拦下本次改动** | `test/architecture-guard.spec.ts` | 必须同步改造门禁（§6），否则重构后门禁即红 |
| C5 | **构造器不是纯 DI，而是行为性接线** | 实测构造器内注册 **12 个** `dts.registerHandler`（L145-198，`gather`/`move`/`rescue`/`reload`/`dungeonClose`/`mine`/`refill`/`cargo`/`repair`/`homeFoundation`/`homeConstruct`/`proxySpeak`）并 fire 启动迁移 `void this.recoverOrphanDelayedMarkers()`（L216） | 重构时不得把构造器当"只存依赖"处理：接线与启动迁移必须留在门面或随 `delayed` 组整体迁移，且注册时序不可变（§4.2） |
| C6 | **存在 6 个实例状态字段，必须整体迁移** | `gatherStartInflight`(采集并发去重)、`tradeLocks`(交易串行化)、`playerUpdateTimers`/`mapUpdateTimers`(推送防抖定时器)、`revCounters`(推送版本单调计数)、`static RANKING_SUB_TYPES` | 状态与使用它的方法族必须同批同目标迁移；状态留在门面会破坏"门面仅委托"（§4.1 归属表） |
| C7 | **推送子系统依赖上下文查询方法，不能直接进支撑层** | `doPushPlayerUpdate` 内调 `buildPlayerInfo`（panel 组）、`doPushMapUpdate` 内调 `getMapOverview` | 推送/防抖/rev 子系统先留门面（§4.3），P3 `panel` 拆出后再评估随迁或独立 `game-push.service.ts` |

**C4 展开**：门禁中两条规则按**文件名**读取 `game.service.ts`：

- `game.service.ts 行数只减不增`（L473-490）
- `延时任务结算入口必须自串行`（L373-403，按名切片 8 个结算函数体，检查 `enqueueUserWrite`）

因此**方法一旦迁出，必须同步改造这两条门禁的扫描目标**，否则测试失败。这不是可选项。

---

## 3. 依赖图谱（方案的技术依据）

### 3.1 组级依赖（调用次数 TOP 20）

| from → to | 次数 | | from → to | 次数 |
|---|---|---|---|---|
| shop → support | 31 | | gather → panel | 4 |
| home → shop | 15 | | movement → gather | 4 |
| panel → gather | 13 | | movement → panel | 4 |
| vehicle → support | 11 | | home → quest | 4 |
| delayed → support | 11 | | delayed → gather | 4 |
| fusion → shop | 11 | | quest → dungeon | 3 |
| pet → support | 10 | | vehicle → inventory | 3 |
| movement → support | 9 | | home → vehicle | 3 |
| skill → ranking | 9 | | equip → fusion | 3 |
| quest / gather / panel / dungeon → support | 各 7 | | ranking → vehicle | 3 |

共 **73 条跨组边 / 约 207 次调用**。

### 3.2 强连通分量（SCC）

```
SCC#0 (3 个)：shop, fusion, support
SCC#1 (11 个)：home, delayed, dungeon, ranking, vehicle, panel,
              inventory, gather, movement, rescue, quest
```

**即 20 个组中 14 个落在环内。** 缩点后的 DAG 分层：

| 层 | 成员 | 含义 |
|---|---|---|
| **L0** | `skill`、`equip`、`pet`、`time`、`admin`、6 个未归类方法 | **天然叶子，可独立拆出** |
| **L1** | 11 组核心簇（SCC#1） | 互相递归，需断边或 `forwardRef` |
| **L2** | `shop`、`fusion`、`support`（SCC#0） | 依赖上游，抽出 `support` 后可解 |

### 3.3 共享支撑层成员（按「被多少个不同组调用」排序）

| 被调用组数 | 方法 | 行数 | 调用方 |
|---|---|---|---|
| **7 组** | `roundText` | — | vehicle, dungeon, fusion, panel, pet, shop, unassigned |
| **5 组** | `incrementMarker` | 4 | movement, gather, quest, time, equip |
| **5 组** | `millisecondsToText` | 6 | quest, gather, panel, skill, pet |
| **4 组** | `normalizeMarkers2` | 5 | movement, gather, delayed, pet |
| **3 组** | `parseJsonArray` | 9 | movement, quest, shop |
| 2 组 | `randomInt`、`setMarkers2`、`getCurrentMap`、`itemName` | — | 见 §附录 A |
| 1 组 | `hasEquip`、`itemType`、`formatFusion*`、`getPlayerName` 等 13 个 | — | 见 §附录 A |

> `roundText` 与 `round2Text` 是双实现，应在 P1 合并为对 `game-text.util.formatDisplayNumber` 的单点委托。

**⚠️ `roundText` 不是纯函数（09-12 实测补充）**：`roundText`(L16969，26 行) 方法体内调用了 `isFusionWeapon`（**fusion 组**）与 `itemQuantity`（**shop 组**）——这正是 SCC 输出中 `support → fusion`、`support → shop` 各 1 条出边的来源。含义有两层：

1. **P1-1（消重）必须先于 P1-3（搬支撑层）**：不先消重就把 `roundText` 原样搬进 `GameSupportService`，会把这两条业务回边一起带进支撑层，直接违反 §4 原则 2（零回边），G7 门禁即红。
2. 若 P1-1 完成后 `roundText` 仍需保留业务分支，则其依赖的 `isFusionWeapon`/`itemQuantity` 必须一并下沉为纯函数（入 utils 或支撑层），不得让支撑层注入上下文子服务。

另：脚本 `analyze-scc-layers.js` 的共享候选名单 `SHARED_CANDIDATES` 共 24 个方法，比初稿附录 A 多出 **`updateMapBuildings`、`localTodayString`** 两个（因当前跨组入度未显现而未列入入度表）。附录 A 已按 24 个口径修正；`updateMapBuildings` 疑似应归属 home/panel 域而非支撑层，P1-0 刷新脚本时一并裁定。

### 3.4 残环判定（模拟"已抽出 support"）

把 `support` 视为已独立并忽略其边后重新求 SCC：

```
残环 (11)：home, delayed, dungeon, ranking, vehicle, panel,
          inventory, gather, movement, rescue, quest
可独立拆出：9 个 → shop, skill, fusion, equip, pet, time, admin, support, unassigned
```

**结论（重要，且是方案的核心判断）：**

- 抽出 `support` **不改变** SCC#1 的成员集合 —— 因为该簇的互相调用不经过 support。
- 但抽出 `support` 消除了 **约 114 次 / 18 个组**的边，使 `shop`/`fusion` 脱离 SCC#0，**把可独立拆出的组从 6 个提升到 9 个**。
- SCC#1 的内核是 **{panel, gather, movement, vehicle, inventory}**（`panel↔gather` 13/4、`movement↔gather` 4/2、`movement↔vehicle` 2/2、`gather↔inventory` 2/2）。外围组（`home`/`delayed`/`dungeon`/`ranking`/`rescue`/`quest`）通过 1~4 次的单向或弱双向边挂在内核上。

**因此 P3 的策略是：先拆外围 6 组，再对内核对症处置（聚类合并 或 `forwardRef`），而不是对整个 11 组一刀切。**

### 3.5 两个分析脚本的口径差异（引用数据时必须注明）

| 脚本 | 分类机制 | 当前状态 |
|---|---|---|
| `analyze-god-service.js` | **实时启发式**：每次运行重新扫描源码按上下文归类 | 反映 09-12 最新代码：未归类已从 6 个涨到 **14 个**（`constructor`、`handleAttack`、`settleGatherResource`、`handleLieDown`、`handleGetUp`、`backpackQuantity`、`addBackpackItem`、`getCurrentMap`、`updateMapBuildings`、`remainingRescueSeconds`、`formatRescueSeconds`、`setRescueVehicleHp`、`handleConfirmHelp`、`getPlayerName`） |
| `analyze-scc-layers.js` | **手工快照**：内嵌 `G` 表（方法名 → 组）+ `SHARED_CANDIDATES` 支撑层名单 | G 表停留在 09-11；存在**重复归属**（`handleExitVehicle` 同时在 vehicle/movement、`handleVehicleOps` 同时在 vehicle/skill，脚本取先注册者） |

**推论**：本方案 §3.2/§3.4/附录 B 的 SCC 与分组结论基于 scc-layers 快照，组规模数字与 god-service 实时输出存在 ±2 方法 / ±200 行的抖动。**P1-0 必须先把 G 表刷新到当前 HEAD（补齐 14 个未归类方法的归属、清洗重复归属），并作为每批迁出后的固定维护义务**，否则残环复核（R4）会在过期数据上运行。

---

## 4. 目标架构

```
         GameCommandHandler (594 分支 / 约 200 处调用)   45 个 spec (173 方法)      controller / command.service
                        \                              /                        / chat.gateway / schedule / sync-projector
                         v                            v                       v
                    ┌───────────────────────────────────────┐
                    │   GameService（门面：委托 + 接线 + 推送） │
                    │   约 1,300 行（委托 427 + 构造器接线 + 推送子系统）│
                    └───────────────────────────────────────┘
                                     │
        ┌────────────┬───────────────┼───────────────┬────────────┐
        v            v               v               v            v
    [移动/载具]  [采集/面板]      [商店/交易]     [任务/对话]   [其余 14 组]
        └────────────┴───────────────┼───────────────┴────────────┘
                                     v
                    ┌───────────────────────────────────────┐
                    │   GameSupportService（共享支撑层）      │
                    │   无业务语义 · 零回边 · 18 组共用       │
                    └───────────────────────────────────────┘
```

**四条设计原则：**

1. **门面保留全部同名方法，包括私有辅助**（满足 C1）：`GameService` 对全部 427 个方法保留一行委托 `return this.xxxService.sameName(args)`。这不只是对外兼容：**迁移期间留在 `GameService` 里的未迁移方法，其 `this.已迁移方法()` 调用正是通过门面委托触达新实现的** —— 门面是过渡期方法间互调的枢纽，私有方法一旦被跨组（或被 spec）引用，就不能在门面上消失。跨子服务被调用的方法在子服务上声明为 `public`（放弃原 `private` 语义）；仅子服务内部使用的辅助保持 `private`。
2. **支撑层零回边**（满足 C3）：`GameSupportService` 不得注入任何上下文子服务，也不得调用它们的实例方法。依赖白名单仅限基础设施：`PrismaService`、`PlayerService`、`PlayerMutateService`、`StaticDataService`、`ChatService`（推送 emit 用）等。**当前实测存在 2 条违规出边（`roundText → isFusionWeapon`/`itemQuantity`），由 P1-1 消重先行消除（§3.3）**。
3. **外围优先**（降低 C3 难度）：先拆 L0 叶子组，再拆 SCC#1 外围，最后处理内核。
4. **`forwardRef` 是兜底而非首选**：仅在内核残余环上使用（项目已有先例：`game.module.ts` 对 `GameSyncModule` / `AdminModule` / `FeedbackModule` 的 `forwardRef`；`sync-projector.service.ts` 对 `GameService` 的 `forwardRef` 注入说明**跨模块环已经真实存在一处**，拆分时不得再新增同类）。

### 4.1 实例状态归属表（C6，逐字段裁定）

`GameService` 现有 6 个状态字段 + `logger`，迁移时**字段与唯一使用它的方法族必须同批、同目标文件**：

| 字段 | 类型 | 当前用途 | 归属 | 同批迁移的方法族 |
|---|---|---|---|---|
| `gatherStartInflight` | `Map<number, number>` | 采集并发去重（同一玩家重复触发采集） | **gather 域** | 采集入口/结算相关方法 |
| `tradeLocks` | `Map<string, Promise<void>>` | 交易读改写窗口串行化（`withTradeLock`） | **shop 域** | `withTradeLock` + 其唯一调用点（home-trade 键） |
| `playerUpdateTimers` | `Map<number, NodeJS.Timeout>` | 玩家状态推送 300ms 防抖 | **推送子系统（暂留门面，§4.3）** | `pushPlayerUpdate`/`doPushPlayerUpdate` |
| `mapUpdateTimers` | `Map<number, NodeJS.Timeout>` | 地图面板推送 300ms 防抖 | 同上 | `pushMapUpdate`/`doPushMapUpdate` |
| `revCounters` | `Map<string, number>` | 推送版本单调计数（乱序丢包） | 同上 | `nextRev` |
| `RANKING_SUB_TYPES` | `static readonly array` | 排行子类型定义 | **ranking 域**（P2-1 随迁） | 排行榜方法 |
| `logger` | `Logger` | 日志 | 门面保留自己的；每个子服务**自建** `new Logger(<子服务名>)` | — |

> 检验规则：每批迁出后，门面类体内不得残留任何 `Map`/`Set`/`Timer` 类业务状态字段（推送 3 字段在 P3 前除外）——可写进门禁脚本作为自动化断言。

### 4.2 构造器行为接线策略（C5）

构造器除了 29 个参数赋值外还有两类**行为**，重构策略如下：

1. **延时结算回调注册**（实测 **12 个** `dts.registerHandler(...)`，L145-198：`gather`/`move`/`rescue`/`reload`/`dungeonClose`/`mine`/`refill`/`cargo`/`repair`/`homeFoundation`/`homeConstruct`/`proxySpeak`）：
   - **注册动作本身保留在 `GameService` 构造器**（门面是唯一知道全部延时入口的地方，时序不变）；
   - 回调体内的 `this.completeVehicleRepair(...)` 等改为门面同名委托 —— 即回调代码**原样不动**，因门面委托机制天然成立；
   - P3-3 拆 `delayed` 组时再评估是否把注册逻辑迁入 `DelayedSettleService`（届时门面构造器改为调用 `this.delayedSettleService.registerAll()`，一次迁移一个整块）。
2. **启动迁移**：`void this.recoverOrphanDelayedMarkers().catch(...)`（L216）**永久保留在门面构造器**，`recoverOrphanDelayedMarkers` 方法本体随 `delayed` 域迁移、门面留委托。

> 禁止事项：不得把 `registerHandler` 拆散到各域子服务的构造器里（注册分散 + 子服务构造器执行顺序不可控 = 延时结算静默失效，见 R9）。

### 4.3 推送/防抖子系统（暂留门面，C7）

`pushPlayerUpdate` / `pushMapUpdate` / `doPushPlayerUpdate` / `doPushMapUpdate` / `nextRev` + 3 个状态 Map 构成一个**有状态的对外推送子系统**：

- **为什么暂留门面**：`doPushPlayerUpdate` 依赖 `buildPlayerInfo`（panel 组）、`doPushMapUpdate` 依赖 `getMapOverview` —— 进支撑层违反零回边（原则 2）；进 panel 组则 panel 是 P3 内核成员，时序上等不起。
- **外部契约**：`game-sync/sync-projector.service.ts` 经 `@Inject(forwardRef(() => GameService))` 调用 `pushPlayerUpdate`/`pushMapUpdate` —— 门面保留这两个**公共**委托即可，调用方零改动。
- **最终归宿**（P3 拆 panel 后再定）：随 panel 子服务迁移，或独立 `game-push.service.ts`（依赖 panel 子服务查询接口）。无论哪种，防抖 Map + rev 计数器必须**整簇**同走，禁止拆散（R10）。

---

## 5. 分批执行计划

### P0・止损规范（立即生效，零代码风险）

**目的**：在拆分完成前，先停止继续恶化（针对 §1.2 第 5、6 项）。

| 动作 | 内容 |
|---|---|
| P0-1 | 新增指令**一律新文件**，挂 `game/commands/<域>.service.ts`，注册到 `command/handlers/` 下**新的 handlerKey 子域**（如 `game-vehicle`），不再写入 `GameCommandHandler.dispatch` 的 594 分支 |
| P0-2 | 门禁补一条：**`game-command.handler.ts` 行数只减不增**（基线取当时实测值），堵住"膨胀转移"通道 |
| P0-3 | 门禁补一条：**新增指令不得在 `game.service.ts` 中出现 `handleXxx`**（可用白名单冻结现有 240 个） |
| P0-4 | 门禁补四条：**`combat-system` / `familiar-system` / `familiar-skills` / `item-system` 四个二期重点文件行数只增不减冻结**（基线=09-12 实测：12,418 / 4,853 / 4,053 / 3,386），堵住其余膨胀转移通道（§11.1） |

> P0-3 的实现建议：在 `architecture-guard.spec.ts` 中固化"当前 240 个 handle 方法名"的清单哈希或计数上限，新增即红。

**P0 验收**：门禁新增 6 条规则均绿（G5、G6、G9 的 4 个文件冻结）；`npm test` 结果与基线一致（1101 通过 / 5 既有失败）。

---

### P1・消重 + 抽出共享支撑层（关键路径）

**目的**：断掉最大量跨组边（约 114 次 / 18 个组），为 P2/P3 铺路。

| 步骤 | 内容 |
|---|---|
| P1-0 | **刷新分析脚本快照（前置条件）**：把 `analyze-scc-layers.js` 的 `G` 表同步到当前 HEAD——归位 14 个未归类方法（`settleGatherResource`→gather、`addBackpackItem`/`backpackQuantity`→inventory 或支撑层、`updateMapBuildings`→home/panel、`remainingRescueSeconds`/`formatRescueSeconds`/`setRescueVehicleHp`→rescue、`handleConfirmHelp`→quest、`getPlayerName`/`getCurrentMap`→支撑层等）、清洗重复归属（`handleExitVehicle`、`handleVehicleOps`）、重算 SCC 与支撑层名单。**此后每批迁出都需同步维护 G 表**（§3.5） |
| P1-1 | **消重（必须最先做，理由见 §3.3）**：删除 `roundText`(L16969)，全量改调 `round2Text` → 再统一为 `game-text.util.formatDisplayNumber` 单点委托；顺带消除 `support → shop/fusion` 两条出边。**【评审定案提前项】** combat-system 的 `displayDamage`（L10107，与 game.service L9160 逐字符相同）同步下沉 `game-text.util`，两处改引 |
| P1-2 | **归并时长辅助**：6 个时长处理辅助（`millisecondsToText`/`formatVehicleTime`/`secondsToTimeText`/`formatMilkRemaining`/`formatUptime`/`formatRescueSeconds`）收敛为 `game-text.util` 中的 2 个统一函数（毫秒→文本 / 秒→文本）。**【评审定案提前项】** combat-system 的 `msToTimeTextLocal`（全库第 7 个时长辅助）改为引用统一函数 |
| P1-3 | **新建 `game-support.service.ts`**，迁入 §3.3/附录 A 全部成员（24 个方法 / 约 330 行），按"被调用组数"从高到低迁；**并迁入 `mutatePlayer`**（跨域写模型收口薄封装，7 处调用——它对 `PlayerMutateService` 的降级回退路径依赖 `playerService.enqueueUserWrite`，全部属基础设施白名单）。支撑层依赖白名单见 §4 原则 2 |
| P1-4 | `GameService` 内保留同名委托方法（满足 C1，含私有辅助——28 个 `Object.create` 桩会直调它们） |
| P1-5 | **修复第 2 类缺陷**：内联品质映射 20 处 → `equipmentQualityLabel`；秒/毫秒启发式 3 处 → `expire-time.util`；手写两位小数 2 处 → `roundItemQuantity`；手写 `backpack.push` 2 处 → `mergeBackpackItem` |
| P1-6 | **建立测试工厂 + 修复受影响桩**：新增 `test/helpers/game-service-stub.factory.ts`，统一构造"门面桩 + 已迁移子服务桩"（`Object.create(GameService.prototype)` 后挂子服务实例或手写桩对象）；修复因 P1 迁移而委托目标缺失的 spec。此后每批 P2/P3 迁移都必须同步修复该批受影响 spec（R8 的固定缓解动作） |

**P1 验收**：
- `tsc -p tsconfig.build.json --noEmit` exit 0
- 架构门禁 22/22 绿（含 P0 新增 6 条规则）
- `npm test` == 基线（1101 通过 / 5 既有失败，**不得新增失败**；因 P1 迁移被修复/改造的 spec 全绿）
- `game.service.ts` 行数**下降** ≥ 330，同步下调 `GAME_SERVICE_LINE_BASELINE`
- 脚本复核：`support` 的入度边归零（除 `GameService` 门面本身）；`support` 的**出度边也归零**（P1-1 后 `roundText` 出边消除，G7 可断言 0 出边）
- `RANKING_SUB_TYPES` 等 §4.1 表中非推送状态字段已随批迁出，门面无残留业务状态 Map

---

### P2・拆 9 个无环组（低风险，可并行的独立批次）

依据 §3.4，抽出 `support` 后可独立拆出的 9 个组。**建议按"行数升序"推进**（先小后大，快速验证流程）：

| 批 | 目标组 | 方法数 | 行数 | 新文件 |
|---|---|---|---|---|
| P2-1 | `ranking` | 13 | 270 | `game/commands/ranking-command.service.ts` |
| P2-2 | `admin` | 17 | 375 | `game/commands/admin-command.service.ts` |
| P2-3 | `fusion` | 17 | 415 | `game/commands/fusion-command.service.ts` |
| P2-4 | `time` | 8 | 553 | `game/commands/time-settle.service.ts` |
| P2-5 | `pet` | 22 | 577 | `game/commands/pet-command.service.ts` |
| P2-6 | `equip` | 25 | 758 | `game/commands/equip-command.service.ts` |
| P2-7 | `skill` | 22 | 832 | `game/commands/skill-command.service.ts` |
| P2-8 | `shop` | 31 | 1,225 | `game/commands/shop-trade.service.ts` |

> `shop → support` 31 次已是最大跨组边，P1 完成后该边指向 `GameSupportService`，P2-8 可安全拆出。
>
> **数据漂移注**：上表行数为 09-11 快照。09-12 复测（HEAD `b1bb5cc`）实测已变为：ranking 17 方法/344 行、admin 18/406、pet 23/649、time 9/571 等（god-service 口径）。**以 P1-0 刷新脚本后的输出为准**，本表只定批次顺序，不锁定数字。

**每批 DoD**：见 §7。

---

### P3・拆 11 组核心簇（高风险，需断边设计）

**第 1 步：外围 6 组**（弱耦合，单向边为主）

| 批 | 目标组 | 方法数 | 行数 |
|---|---|---|---|
| P3-1 | `quest` | 49 | 2,159 |
| P3-2 | `home` | 19 | 745 |
| P3-3 | `delayed` | 13 | 491 |
| P3-4 | `dungeon` | 14 | 832 |
| P3-5 | `rescue` | 37 | 723 |

> `delayed` 批含 8 个延时结算入口，**必须同步改造门禁 L373-403**（见 §6）。这是 P3 唯一强制先做的门禁改动。
>
> **补充（09-12 实测）**：`delayed` 域迁移还涉及 §4.2 的构造器接线 —— `dts.registerHandler` 注册块与 `recoverOrphanDelayedMarkers` 启动迁移。门禁 G2 的 8 个结算入口名单为：`settleGatherResource`/`performArrival`/`completeRescue`/`completeReload`/`settleManualMine`/`completeRefill`/`completeCargoSummon`/`completeVehicleRepair`，迁出后门禁切片目标须同步指向新文件。`homeFoundation`/`homeConstruct` 的结算已落在 `FamiliarSystemService`，不受 G2 约束，无需处理。

**第 2 步：内核 5 组**（`panel` / `gather` / `movement` / `vehicle` / `inventory`）

两个候选策略，建议 **B**：

| 策略 | 做法 | 代价 |
|---|---|---|
| A・全量 `forwardRef` | 5 个服务互相 `forwardRef` 注入 | 依赖图仍成环，仅编译期解耦；运行时初始化顺序脆弱 |
| **B・按双向边强度聚类合并** | 合并为 2 个服务：`{movement, vehicle}` → 移动载具服务（2,023+1,242 行）；`{panel, gather, inventory}` → 场景资源服务（1,462+1,749+369 行）。残余环用 `forwardRef` | 单服务仍偏大（2.6~3.6k 行），但**依赖图真正无环** |

> 规模观测：合并后 2 个服务约 3.3k / 3.6k 行，仍显著优于单文件 17.4k，且可后续按子域二次拆分。

**P3 验收**：额外要求 `git diff` 复核 `GameSupportService` **未新增任何回边**（不得注入上下文子服务）。

---

### P4・收尾

| 步骤 | 内容 |
|---|---|
| P4-1 | 全量脚本复核：`analyze-scc-layers.js` 输出「残环已全部消解」 |
| P4-2 | 补齐各子服务的模块文档注释（职责 / 依赖 / 单一真相源声明 / 对应原版 ecode 位置） |
| P4-3 | `game.module.ts` 注册全部新服务；`GameService` 构造器末尾追加 `@Optional` 依赖（满足 C2） |
| P4-4 | 门禁最终校准：`GAME_SERVICE_LINE_BASELINE` 下调至门面实际行数；`RAW_SAVEPLAYER_BASELINE` 按实测校准 |
| P4-5 | 补充**集成测试**：对每个新子服务补 1 组桩测试；保留并跑通全部 45 个既有 spec |

---

## 6. 门禁改造清单

| # | 门禁位置 | 现状 | 改造 |
|---|---|---|---|
| G1 | `architecture-guard.spec.ts` L473-490 | 读 `game.service.ts` 断言行数 ≤ 17,434 | **逐批下调基线**；P1 后 ≤ 17,100，每批按实降 |
| G2 | 同文件 L373-403 | 按名在 `game.service.ts` 中切片 8 个结算入口（`settleGatherResource`/`performArrival`/`completeRescue`/`completeReload`/`settleManualMine`/`completeRefill`/`completeCargoSummon`/`completeVehicleRepair`），检查函数体内 `enqueueUserWrite` | **改为扫描目标文件可配置**；`delayed` 批迁出后指向 `time-settle`/`delayed-settle` 服务。注意其切片逻辑（`async ${fn}(` 起始、切到下一个方法声明）在目标文件中同样适用 |
| G3 | 同文件 L274-280 | 断言 `command.service.ts` 含 `this.playerMutate.mutate(ctx.userId` | **不变**（不动调度层） |
| G4 | 同文件 L330-350 | 断言业务代码禁写 `prisma.gameMap.update` | **不变**（新子服务遵守同一规则） |
| **G5（新增）** | — | — | `game-command.handler.ts` 行数只减不增（P0-2） |
| **G6（新增）** | — | — | `game.service.ts` 中 `handleXxx` 数量只减不增（P0-3） |
| **G7（新增）** | — | — | `GameSupportService` 不得 `import` 任何 `game/commands/*.service`（支撑层零回边）。**断言标准：支撑层出度边 = 0**。当前已实测 2 条出边（`roundText → isFusionWeapon`/`itemQuantity`），P1-1 消除后 G7 才可落地，因此 G7 与 G1 一样是"逐批启用"的门禁 |
| **G8（新增）** | — | — | `game.service.ts` 类体内不得残留业务状态 `Map`/`Set`/`Timer` 字段（白名单：`playerUpdateTimers`/`mapUpdateTimers`/`revCounters`，P3 后白名单清空），防状态字段散落（§4.1） |
| **G9（新增）** | — | — | `combat-system` / `familiar-system` / `familiar-skills` / `item-system` 四文件行数冻结（P0-4，基线=09-12 实测），二期拆分时逐文件改为准许下降模式（§11.1） |

**冻结生命周期（2026-09-12 评审补充：各门禁的解除/转化时机）** —— 冻结是临时手段而非永久状态，但三组门禁的解除时机不同：

| 门禁 | 冻结对象 | 解除 / 转化时机 |
|---|---|---|
| G1 | `game.service.ts` | **不解除、逐批下调**：P1 后 ≤17,100，每批按实降，P4-4 降到门面实际行数（约 1,300 行）。此后门禁保留但失去约束力，转为"防复发护栏"——往门面塞业务逻辑会再触发 |
| G5 | `game-command.handler.ts` | 一期无拆它的批次，冻结保持至将来拆调度层（594 分支迁新 handlerKey 子域）。因 P0-1 新指令本就不进它，日常无感 |
| G9×4 | combat-system 等 4 文件 | **一期结束后仍在冻结**；各自**二期拆分开工时**切换为"准许下降"模式，随拆分逐步下调，最终落在拆分后子服务的实际行数 |

> 冻结防的是"无声膨胀"：基线是 spec 里的一个数字，真有正当理由加行数时，显式上调基线走 PR 评审即可——被门禁拦下的改动必须被看见，而不是被禁止。

---

## 7. 验收标准（每批必须全绿，Definition of Done）

一批完成的唯一判据 —— **以下 7 条同时满足**：

1. `npx tsc -p tsconfig.build.json --noEmit` → **exit 0**
2. `npx jest --config jest.full.config.js --runInBand test/architecture-guard.spec.ts` → **22/22 绿**（含 G5~G9）
3. `npx jest --config jest.config.js` → **1101 通过 / 5 既有失败**，**不得出现新失败**
   - 既有失败基线（**与本任务无关，禁止误判为回归**）：`test/excalibur-burn.spec.ts` 2 个、`test/familiar-scorched-finger.spec.ts` 3 个；根因是测试桩缺 `systemConfig.get`
4. `npm test`（全量含真实库套件，串行）→ 与基线一致
5. `game.service.ts` 行数**下降**，且基线已同步下调
6. `analyze-scc-layers.js` 复核：目标组已脱离残环 / 支撑层入度未增加（G 表须已同步本批迁出结果，§3.5）
7. **本批涉及的 `Object.create` 桩 spec 已修复/迁移到测试工厂构造**（R8 固定动作）；门面类体内无新增业务状态字段（G8）

---

## 8. 回滚方案

| 层级 | 手段 |
|---|---|
| 单批回滚 | 每批**独立提交**（提交信息 `refactor(game): 抽出 <域> 子服务`），回滚即 revert 该提交 |
| 部分回滚 | 新子服务与门面委托**同时存在**，可只把门面方法体换回原实现，保留子服务文件不动 |
| 全量回滚 | 全部改动集中在 `game/` + `command/handlers/` + 受影响 spec（最多涉及 28 个 `Object.create` 桩 spec）+ `test/helpers/` 工厂 + 门禁 spec，`git revert` 批次提交即可 |
| **禁止事项** | 本重构**不涉及** `git stash` / `reset` / 强制推送；不做数据库迁移；不改写模型 |

**安全前提**：本方案不改动任何玩家数据路径、不改写模型入口、不改 `PlayerMutateService`。因此**每批都可在游戏正常运行期间部署**（与既往部署约定一致）。

---

## 9. 风险登记表

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 抽出方法后**门面委托遗漏**，导致指令静默失效 | 中 | 高 | 每批用脚本比对"迁移前方法名集合 == 门面委托方法名集合"（**含私有辅助与 `pushPlayerUpdate`/`pushMapUpdate`/`buildMerchantInventory` 等非 handler 公共方法**），差集为空才提交；比对范围必须覆盖 §0 第 4 条列出的全部调用方，而非仅 `GameCommandHandler` + spec |
| R2 | 内核 5 组 `forwardRef` 后**模块初始化顺序**再次脆弱 | 中 | 高 | 优先策略 B（聚类合并）；合并后仍成环才上 `forwardRef`，并补一条初始化顺序冒烟测试 |
| R3 | `@Optional` 位置参数错位导致**测试静默通过但行为不同** | 中 | 中 | 构造器现为 29 参数（23 必选 + 6 尾部可选）；新依赖**只追加构造器末尾**；提交前跑全量 45 个 spec |
| R4 | 迁移过程中**跨组私有辅助被误带出**，子服务互相 `import` 造成新环 | 高 | 中 | 每批提交前跑 `analyze-scc-layers.js`（G 表须已同步，§3.5），残环数不得增加 |
| R5 | 门禁基线**忘记下调**，后续无法度量进度 | 中 | 低 | 纳入 DoD 第 5 条 |
| R6 | 既有 5 个失败被误判为本次回归，造成排查浪费 | 高 | 低 | 基线已在 §7.3 固化；每批提交信息中标注该基线 |
| R7 | 拆分期间并行开发产生**冲突** | 中 | 中 | P0 先建立"新指令新文件"规范，降低同一文件竞争 |
| R8 | **28 个 `Object.create(GameService.prototype)` 桩在方法迁出后委托目标为 `undefined`**，调用即 TypeError，测试大面积红 | **高** | 高 | P1-6 建测试工厂；每批 DoD 第 7 条强制修复该批受影响 spec；修法优先"spec 直接构造子服务"（用例归属新模块），次选"桩上挂子服务实例" |
| R9 | **构造器 `dts.registerHandler` 接线被拆散/遗漏**，延时结算静默失效（编译期与多数测试都发现不了） | 中 | 高 | §4.2 定死策略：注册块留门面构造器、回调体走门面委托；补一条冒烟测试断言"注册的延时 handler 数量 ≥ 现值（12 个，L145-198）" |
| R10 | **推送子系统（防抖 Map + rev 计数器）被拆散或误入支撑层** → 防抖失效 / rev 乱序 / 前端旧包覆盖新包 | 低 | 高 | §4.3 定死：整簇暂留门面；G8 白名单锁定 3 个字段，P3 后白名单清空 |
| R11 | **分析脚本 G 表快照过期或重复归属** → 残环复核（R4）在失真数据上运行，假绿 | 高 | 中 | P1-0 刷新并清洗 G 表（§3.5）；G 表维护纳入每批 DoD；引用组级数据时注明脚本与口径 |

---

## 10. 编码规范（本次重构统一口径）

> 术语命名以《命名与术语优化方案》为准，以下仅约束本次重构新增部分。

### 10.1 文件组织

```
server/src/modules/game/
├── game.service.ts                 # 门面：仅委托，不写业务逻辑
├── game-support.service.ts         # 共享支撑层：无业务语义、零回边
├── commands/                       # 上下文子服务（本次新增）
│   ├── movement-vehicle.service.ts
│   ├── gather-panel.service.ts
│   ├── shop-trade.service.ts
│   ├── quest-dialogue.service.ts
│   ├── equip-command.service.ts
│   ├── skill-command.service.ts
│   ├── pet-command.service.ts
│   ├── dungeon-challenge.service.ts
│   ├── rescue-white.service.ts
│   ├── home-build.service.ts
│   ├── inventory-command.service.ts
│   ├── fusion-craft.service.ts
│   ├── ranking.service.ts
│   ├── admin-command.service.ts
│   └── time-settle.service.ts
└── <既有服务>.service.ts            # 保持原位不动
```

### 10.2 命名

| 类别 | 规范 | 示例 |
|---|---|---|
| 子服务类名 | `<域>Service`，域名为业务名词而非技术名词 | `ShopTradeService`、`RescueWhiteService` |
| 文件名 | kebab-case，以职责结尾 | `shop-trade.service.ts` |
| 方法名 | **保持原方法名不变**（满足 C1，禁止重命名） | `handleShop` 迁移后仍为 `handleShop` |
| 方法可见性 | 跨子服务（或经门面）被调用的方法一律 `public`；仅本子服务内部使用的辅助保持 `private`。**禁止**为绕开可见性用 `['...']` 或 `as any` 穿透 | `applySettleGatherResource` 为 public |
| 私有辅助 | 迁移时保留原名，加域前缀仅在**跨域重名**时使用 | `formatVehicleTime` |
| 门面委托 | 与目标方法同名，一行 `return this.xxx.方法名(...)` | — |

### 10.3 注释（每个新子服务必须包含）

```ts
/**
 * <域中文名> 指令域服务
 *
 * 职责：<该域负责的指令与结算>
 * 依赖方向：<本服务依赖谁>；<谁依赖本服务>
 * 单一真相源：<本域内不得重复实现的出口，如必须走 equipmentQualityLabel>
 * 对口原版：<原版 ecode 文件 + 行号区间>
 *
 * ⚠️ <保留的原版笔误 / 偏差，如有>
 */
```

### 10.4 必须遵守的既有红线（迁移时逐条自检）

1. 背包写入一律 `mergeBackpackItem`；装备入包一律 `generateRewardEquipment`
2. 装备品质展示一律 `equipmentQualityLabel`
3. 强化展示一律 `formatReinforcedEquipAttrs`；强化计算唯一入口 `ItemSystemService.applyEquipReinforce`
4. 时间口径一律 `expire-time.util`
5. 三池数值一律 `player-pool.util`
6. 数值收敛：`/100` 生成 → `formatBonusStats` 显示 → `roundItemQuantity` 累加
7. 玩家写入一律 `PlayerMutateService.mutate`（禁止新增裸 `savePlayer`）

---

## 11. 其他超大文件与跨文件统一出口（二期登记，本次实施不动）

> 本章回答两个问题：**巨型文件是否只有 game.service 一个？统一功能出口在 game.service 之外被绕过多少？** 结论基于 2026-09-12 全库只读扫描。一期（P0~P4）不改这些文件（除 §11.3 标注的两个零行为变化提前项）；本章目的是**止损登记 + 二期范围划定**，避免"拆完 game.service 才发现隔壁还有个更大的"。

### 11.1 全库文件规模清单（≥1,000 行）

| 文件 | 行数 | 方法数 | 测试套件引用 | 状态 |
|---|---|---|---|---|
| `game/game.service.ts` | 17,413 | 427 | 45 | **一期范围**（本方案 §1~§10） |
| `game/combat-system.service.ts` | **12,418** | **186** | 23 | **二期重点**（第二个上帝文件） |
| `game/familiar-system.service.ts` | 4,853 | 41 | 14 | 二期 |
| `game/familiar-skills.service.ts` | 4,053 | 42 | 11 | 二期 |
| `game/item-system.service.ts` | 3,386 | 50 | 13 | 二期 |
| `game/bonus.service.ts` | 2,365 | 68 | 15 | 观察名单 |
| `game/player.service.ts` | 2,155 | 49 | 45 | 观察名单（含合法基础设施写路径） |
| `game/home.service.ts` | 2,054 | 38 | — | 观察名单 |
| `command/handlers/game-command.handler.ts` | 2,041 | — | — | **一期 G5 已冻结** |
| `game/map.service.ts` | 1,922 | 31 | — | 观察名单 |
| `game/item.service.ts` | 1,920 | 28 | — | 观察名单 |
| `game/task.service.ts` | 1,441 | — | — | 观察名单 |
| `game/handbook.service.ts` | 1,379 | 58 | — | 观察名单 |
| `admin/admin.service.ts` | 1,227 | — | — | 观察名单 |
| `game/schedule.service.ts` | 1,011 | 7 | — | 观察名单 |

**止损动作（P0-4）**：一期就把行数冻结门禁扩展到 4 个二期重点文件（`combat-system` 12,418 / `familiar-system` 4,853 / `familiar-skills` 4,053 / `item-system` 3,386，基线=当前实测），堵住 §1.2 第 6 项"膨胀转移"的其余通道 —— 否则 game.service 被冻结后，新增战斗/使魔/物品逻辑会涌入这 4 个无门禁文件，重演 `game-command.handler` 1,009→2,041 的教训。观察名单文件暂不冻结，二期复核后再定。

### 11.2 combat-system.service.ts 概况（二期重点，本次不拆）

- **186 个方法 / 12,418 行**（平均 67 行/方法），23 个测试套件直连 —— 测试基础比 game.service（45 套对 427 方法）更扎实，未来拆分的回归风险更低。
- 已实测的跨文件重复（§11.3 收口）：`displayDamage` 与 game.service **逐字符相同**；`msToTimeTextLocal` 是全库第 7 个时长格式化辅助。
- 二期方法：把 §附录 C 的三个分析脚本小改为支持任意目标文件，先跑依赖图谱 + SCC，再复制本方案的方法论（门禁冻结 → 支撑层/出口收口 → 按域拆分 → 每批 DoD）。**本章不预设计拆分批次** —— 没有调用图数据支撑的批次表是伪精确。

### 11.3 跨文件统一出口清单（"统一功能出入口"实测绕过点）

| # | 统一出口 | 绕过现状（实测） | 处理 |
|---|---|---|---|
| 1 | **玩家写模型**：`PlayerMutateService.mutate`（红线 §10.4-7） | 裸 `savePlayer` 全项目 276 处，game.service 占 114（一期已规划）；**之外业务侧仍有约 162 处**：familiar-skills 54、familiar-system 47、item-system 23、item 10、combat-system 8、game-command.handler 5、admin 4、tutorial/schedule/home/dungeon/auto-mine 各 2、achievement 1（player.service/player-mutate 自身 9 处为基础设施实现，合法） | 随各文件二期拆分**一并收口**；一期只靠既有 `RAW_SAVEPLAYER_BASELINE` 门禁防新增 |
| 2 | **玩家读**：统一走 mutate 上下文快照 | `getPlayerData` 直读：game.service 151（一期），item-system 52、familiar-system 50、familiar-skills 49、combat-system 15 | 二期随拆分收口 |
| 3 | **伤害展示**：`displayDamage` | **双实现逐字符相同**：game.service L9160 与 combat-system L10107 均为 `String(Math.round(value \|\| 0))` | **评审定案：提前到一期 P1-1 顺带做**（纯函数下沉 `common/utils/game-text.util.ts`，零行为变化） |
| 4 | **时长格式化**：P1-2 产出的 game-text.util 两函数 | 已扩散 **7 个实现**：game.service 6 个（P1-2 收敛）+ combat-system `msToTimeTextLocal` | **评审定案：提前到 P1-2 顺带改**（改为引用 util，零行为变化） |
| 5 | **背包写入**：增量发放走 `mergeBackpackItem`（8 个文件已在用） | 手写 `backpack.push`：item.service 6、item-system 6、player.service 3、familiar-system 1、familiar-skills 1（+ game.service 2 已在 P1-5）。**注意**：其中相当部分是"替换/取回装备回包"流（`push(replaced)`），语义不是增量合并，**不能机械套 mergeBackpackItem** | 二期逐个审计分流：增量 → `mergeBackpackItem`；替换 → 评估新增 `replaceBackpackEntry` 统一出口或保留原地写并加注释 |
| 6 | **两位小数**：`roundItemQuantity` / `game-text.util` | `toFixed(2)` 手写：familiar-skills 3、handbook 1、combat-system 1 | 二期小项 |
| 7 | **markers2 写入 schema** | 双轨：combat-system 写 `{ name, expireAt }`，familiar-skills L2295 写 `{ 名称, 有效期至 }`；读侧靠 `m?.name ?? m?.名称` 式防御兼容 | 二期统一写入构造器（与 `combatState.normalizeBuffItem` 同源 schema）；动手前先审计 normalize 的兼容范围，**当前不是活性 bug，是schema 漂移隐患** |
| 8 | **物品名解析** | home.service L1260 `getItemName` 与 game.service `itemName` 同族 | 随一期 P3-2（home 域）迁移时合并 |

### 11.4 二期执行原则（登记，不承诺批次）

1. 一期不动 §11 涉及文件，**例外（评审已定案）**：§11.3 第 3、4 行两个零行为变化项提前到 P1-1/P1-2 顺带完成，是仅有的两处一期触碰 combat-system 的改动。
2. 二期沿用一期验证过的方法论：**门禁冻结 → 脚本依赖图谱 → 支撑层/出口收口 → 按域拆分 → 每批 DoD 全绿**；`analyze-*` 脚本先泛化到支持多目标文件。
3. 每个二期文件开工前必须有本方案同等深度的只读分析（调用图 + SCC + 状态字段 + 构造器接线 + 测试桩构造方式），不沿用"猜批次"。

---

## 附录 A・共享支撑层候选明细（24 个，与 `analyze-scc-layers.js` 的 `SHARED_CANDIDATES` 对齐）

| 被调用组数 | 方法 | 行数 | 调用方 |
|---|---|---|---|
| 7 | `roundText` | 26 | vehicle, dungeon, fusion, panel, pet, shop, unassigned |
| 5 | `incrementMarker` | 4 | movement, gather, quest, time, equip |
| 5 | `millisecondsToText` | 6 | quest, gather, panel, skill, pet |
| 4 | `normalizeMarkers2` | 5 | movement, gather, delayed, pet |
| 3 | `parseJsonArray` | 9 | movement, quest, shop |
| 2 | `randomInt` | 12 | gather, delayed |
| 2 | `setMarkers2` | 16 | dungeon, time |
| 2 | `getCurrentMap` | 11 | shop, quest |
| 2 | `itemName` | 4 | shop, delayed |
| 1 | `round2Text` | 11 | quest |
| 1 | `formatGatherNumber` | 9 | gather |
| 1 | `hasEquip` | 12 | dungeon |
| 1 | `secondsToTimeText` | 25 | ranking |
| 1 | `displayDamage` | 9 | ranking |
| 1 | `resolveGatherCmd` | 10 | panel |
| 1 | `updateOwnedSummonMode` | 72 | pet |
| 1 | `hasTrainerAccess` | 18 | time |
| 1 | `itemType` | 4 | shop |
| 1 | `formatReverseNumber` | 4 | shop |
| 1 | `formatUptime` | 31 | admin |
| 1 | `firstPositiveNumber` | 8 | rescue |
| 1 | `getPlayerName` | 11 | gather |
| 待裁定 | `updateMapBuildings` | 10 | 在脚本候选名单但跨组入度未显现，疑似 home/panel 域成员（P1-0 裁定） |
| 待裁定 | `localTodayString` | — | 在脚本候选名单但跨组入度未显现，疑似 time 域成员（P1-0 裁定） |

> 被调用组数为 1 的成员，可在其归属批（P2/P3）一并迁出，不必强留支撑层。
> 另有 `mutatePlayer`（写模型收口薄封装，7 处跨域调用）按 P1-3 一并迁入支撑层 —— 它不在脚本候选名单（脚本只统计 `this.xxx()` 调用边，`mutatePlayer` 是被业务方法调用的入口而非辅助），但语义上属于支撑层。

⚠️ `roundText` 当前方法体内调用 `isFusionWeapon`（fusion 组）与 `itemQuantity`（shop 组）——迁入支撑层前必须先完成 P1-1 消重（§3.3）。

---

## 附录 B・各组规模（scc-layers 09-11 快照口径，合计 427 方法）

> **口径说明（09-12 补）**：本表与 §3 的 SCC 结论同源于 `analyze-scc-layers.js` 的手工快照 G 表。HEAD `b1bb5cc` 之后，`analyze-god-service.js` 实时口径已变为：gather 38/1,775、shop 35/1,246、dungeon 17/874、pet 23/649、ranking 17/344、**未归类 14/286** 等（±2 方法抖动）。**批次顺序不受影响；执行时以 P1-0 刷新后的输出为准**（§3.5）。

| 组 | 方法数 | 行数 | 计划批次 |
|---|---|---|---|
| quest | 49 | 2,159 | P3-1 |
| vehicle | 31 | 2,023 | P3（内核） |
| gather | 36 | 1,749 | P3（内核） |
| panel | 18 | 1,462 | P3（内核） |
| movement | 12 | 1,242 | P3（内核） |
| shop | 31 | 1,225 | P2-8 |
| skill | 22 | 832 | P2-7 |
| dungeon | 14 | 832 | P3-4 |
| equip | 25 | 758 | P2-6 |
| home | 19 | 745 | P3-2 |
| rescue | 37 | 723 | P3-5 |
| pet | 22 | 577 | P2-5 |
| time | 8 | 553 | P2-4 |
| delayed | 13 | 491 | P3-3 |
| fusion | 17 | 415 | P2-3 |
| admin | 17 | 375 | P2-2 |
| inventory | 14 | 369 | P3（内核） |
| support | 23 | 327 | **P1** |
| ranking | 13 | 270 | P2-1 |
| 未归类 | 6 | 213 | 随归属批迁出 |

> 快照口径的未归类 6 个：`constructor`、`handleAttack`（战斗域）、`handleMap`、`handleLieDown`、`handleGetUp`（状态域）、`handleViewAchievements`（成就域）。
>
> **09-12 实时口径新增 8 个未归类**（P1-0 归位）：`settleGatherResource`(gather)、`addBackpackItem`/`backpackQuantity`(inventory/支撑层候选)、`updateMapBuildings`(home/panel)、`remainingRescueSeconds`/`formatRescueSeconds`/`setRescueVehicleHp`(rescue)、`handleConfirmHelp`(quest)。其中 `constructor`（61 行，含 C5 接线）永久留在门面；`handleAttack`（战斗域）建议随战斗域独立批次或并入 P3 内核后的收尾批 —— 现方案未覆盖战斗域拆分，属**已知留白**（战斗方法多为无环叶子，风险低）。

---

## 附录 C・分析脚本用法

```bash
cd server
node scripts/analyze-god-service.js    # 按上下文归类方法 + 行数分布（实时扫描，每次运行反映当前 HEAD）
node scripts/analyze-call-graph.js     # 方法级调用图 + 双向环
node scripts/analyze-scc-layers.js     # 组级 SCC + DAG 分层 + 支撑层入度 + 残环模拟（基于内嵌手工快照 G 表）
```

三个脚本**均为只读分析**，不修改任何业务代码。建议每批提交前跑一次 `analyze-scc-layers.js` 作为残环回归（对应风险 R4）。

> **口径警告（09-12 补）**：`analyze-god-service.js` 是实时启发式归类，`analyze-scc-layers.js` 依赖手工维护的 `G` 表快照（当前停留在 09-11，且存在 `handleExitVehicle`/`handleVehicleOps` 重复归属）。两者对个别方法的组归属有 ±2 方法分歧。引用组级数字时必须注明脚本与时间点；每批迁出后先同步 G 表再跑复核（§3.5、P1-0）。

---

## 决策记录（2026-09-12 评审定案，全部问题已关闭）

| # | 问题 | 决策 | 依据 |
|---|---|---|---|
| 1 | P0 止损包是否立即执行 | ✅ **立即执行（用户拍板）** | 含 P0-1 新指令一律新文件；G5/G6/G9 全部生效。冻结口径确认：**净行数不增**（改 bug / 重构 / 删代码不受限，只禁新增功能） |
| 2 | P3 内核策略 A / B | **B・按双向边强度聚类合并**（按推荐默认定案） | 依赖图真正无环；产出 `{movement,vehicle}` 与 `{panel,gather,inventory}` 2 个服务，残余环才用 `forwardRef` |
| 3 | P2 批次粒度 | ✅ **8 批逐组（用户拍板）** | 每组独立提交、独立跑 §7 DoD，回滚粒度最小 |
| 4 | `roundText`/`round2Text` 消重是否提前 | **提前，即 P1-1 第一动作**（按推荐默认定案） | 零行为变化；且它是 `support → shop/fusion` 出边的唯一来源，P1-3 依赖它先行 |
| 5 | 门禁 G2 扫描目标可配置 | **做**（按推荐默认定案） | `delayed` 批迁出后门禁即红，无其他选择 |
| 6 | 实例状态归属 + 推送子系统暂留门面 | **认可 §4.1/§4.3 裁定**（按推荐默认定案） | 域状态随域走；推送 3 字段 + rev 留门面至 P3 后再定归宿 |
| 7 | 构造器接线策略 | **认可 §4.2 裁定**（按推荐默认定案） | 12 个 `dts.registerHandler` 注册块留门面构造器，回调体走门面委托；启动迁移永久留门面 |
| 8 | 测试桩修复方式 | **(a) 测试工厂 + 每批修复**（按推荐默认定案） | P1-6 建 `test/helpers/game-service-stub.factory.ts`；28 个 `Object.create` 桩按批修复（R8） |
| 9 | §11 其他超大文件 | ✅ **(a) 四文件冻结立即上（用户拍板）；(b) displayDamage 下沉与 msToTimeTextLocal 改引提前到 P1（用户拍板）** | 见 P0-4/G9 与 P1-1/P1-2 提前项 |

> **结论：无未决项。** 实施从 §5 P0 开始；每批独立提交（信息格式 `refactor(game): 抽出 <域> 子服务`），按 §7 DoD 六项全绿后才进入下一批。执行 AI 遇到本方案未覆盖的新情况时，先补只读分析再动代码，不得跳过 DoD。

---

## v2 修订记录（2026-09-12 复核）

以下为本次评审新增/修订的实测结论，均来自只读验证（未改任何业务代码）：

1. **测试桩风险（新增，最重要）**：45 个 spec 中 28 个用 `Object.create(GameService.prototype)` 构造，方法迁出后委托目标为 `undefined`。原方案只覆盖了位置传参场景 → 新增 R8、P1-6、DoD 第 7 条、G8。
2. **构造器是行为性接线（新增）**：构造器内注册 12 个 `dts.registerHandler` 延时回调（L145-198）并 fire `recoverOrphanDelayedMarkers()` 启动迁移（L216）→ 新增 C5、§4.2、R9。
3. **实例状态字段（新增）**：5 个 `Map` + 1 个 `static` 的归属此前无任何安排 → 新增 C6、§4.1 归属表、G8、R10。
4. **推送子系统不能进支撑层（新增）**：`doPushPlayerUpdate` 依赖 panel 组的 `buildPlayerInfo`/`getMapOverview`；且 `sync-projector.service` 经 `forwardRef` 注入门面调用 `pushPlayerUpdate`/`pushMapUpdate`（原 C1 调用面统计遗漏此调用方）→ 新增 C7、§4.3，C1 调用面从 380 处修正为约 420 处并补全 6 类调用方。
5. **`roundText` 含业务回边（新增）**：实测其方法体调用 `isFusionWeapon`（fusion 组）与 `itemQuantity`（shop 组），即 SCC 输出中 `support → shop/fusion` 出边的来源 → P1-1 明确先于 P1-3；G7 断言标准明确为"出度边 = 0"。
6. **构造器参数与行数漂移（修订）**：29 参数（23 必选 + 6 `@Optional`），文件 17,413 行；§1.2 中 `roundText`/`round2Text` 行号已按 09-12 复测更新。
7. **分析脚本口径分歧（新增）**：`analyze-scc-layers.js` 的 G 表为手工快照（未归类 6）与 `analyze-god-service.js` 实时口径（未归类 14）不一致，且有 2 个方法重复归属 → 新增 §3.5、P1-0、R11；附录 A 补齐 24 个成员、附录 B 补口径说明；`handleAttack`（战斗域）拆分为已知留白。
8. **门面可见性规范（新增）**：跨子服务调用的方法一律 `public`（§10.2），原 `private` 语义在子服务边界放弃。
9. **其他超大文件与跨文件统一出口（新增，09-12 全库扫描）**：`combat-system.service.ts` 12,418 行/186 方法为第二个上帝文件；裸 `savePlayer` 在 game.service 之外业务侧仍有约 162 处，`getPlayerData` 直读另有 166 处；`displayDamage` 双实现逐字符相同；时长辅助已扩散至 7 个；markers2 写入 schema 双轨（`{name, expireAt}` vs `{名称, 有效期至}`）。→ 新增 §11 整章、P0-4 四文件冻结门禁、G9、评审问题 9。
10. **P0 验收口径更新**：门禁新增规则从 2 条扩为 6 条（G5、G6、G9×4 文件）；DoD 第 2 条同步为"含 G5~G9"。
11. **评审定案（新增）**：9 个评审问题全部关闭 —— 3 项由用户拍板（P0 止损包立即执行且四文件全部冻结、P2 按 8 批逐组、两个零风险项提前到 P1），其余 6 项按推荐默认定案；决策依据见文末「决策记录」。方案状态由"待评审"转为**"已评审通过，可实施"**。
12. **冻结生命周期澄清（新增）**：明确三组冻结门禁的解除/转化时机（§6 表格）——G1 逐批下调至门面实际行数后转为护栏；G5 保持至将来拆调度层；G9×4 在各自二期拆分开工时才解冻，一期结束后仍有效。

---

> 本方案未改动任何业务代码（全部结论来自只读分析）。评审已于 2026-09-12 定案（见「决策记录」，无未决项），**可进入 §5 P0 实施**。
