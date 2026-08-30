# 玩家状态写入规范

> 这份文档是**强制规范**，由 `server/test/architecture-guard.spec.ts` 自动守门。
> 文档可能过时，测试不会——以测试为准。

## 一、为什么需要这套规范

玩家数据采用「读快照 → 修改 → 整包写回 + version CAS」模型。整包写回意味着
**一次保存会覆盖全部 46 个字段**，因此任何过期快照落库，都会把别人刚写入的结果
整个回滚掉。

历史上反复出现的事故，根因只有两类：

1. **并发互踩**：定时器（采集结算、地图战斗节拍）与玩家指令同时改一个玩家
2. **自我覆盖**：同一条业务链里读了多份快照，子流程落库后上层那份立刻过期

第 2 类**加锁治不了**，因为压根没有第二个写入者。典型症状是某条指令 100% 必现地
报「玩家数据并发冲突，请重试」。

## 二、核心规则

**所有玩家状态变更必须走 `PlayerMutateService.mutate()`，禁止自己调
`getPlayerData` + `savePlayer`。**

```ts
// 正确
await this.mutate.mutate(userId, (ctx) => {
  ctx.player.hp -= 10;
  ctx.backpack.push({ name: '木头', quantity: 5, count: 5, type: '资源' });
  return '砍树成功';
});

// 错误：裸调读档 + 保存
const { player } = await this.playerService.getPlayerData(userId);
player.hp -= 10;
await this.playerService.savePlayer(player);
```

`mutate` 提供三件事，自己裸写全都得不到：

| 保证 | 机制 |
|---|---|
| 串行 | 全程持 `withUserLock` 用户级锁 |
| 单一快照 | 嵌套调用复用同一份 `ctx`（AsyncLocalStorage 识别） |
| 统一落库 | 只有最外层保存并审计货币 |

## 三、单一快照语义（最关键）

嵌套调用同一玩家的 `mutate` **不会**重新读档，而是复用外层 `ctx`：

```ts
await this.mutate.mutate(userId, async (ctx) => {
  ctx.player.hp = 80;
  await this.mutate.mutate(userId, (inner) => {
    inner === ctx;        // true，同一个对象
    inner.player.hp = 60;
  });
  ctx.player.hp;          // 60，内层改动对外层可见
});
// 全程只读档 1 次、落库 1 次
```

**所以子流程必须接收 `ctx` 参数透传，不得以 `userId` 重新读档。**

```ts
// 正确：子流程接收 ctx
private async applySkill(ctx: MutateContext, ...args) { ... }

// 错误：子流程自己读档 —— 这正是「自我覆盖」的来源
private async applySkill(userId: number, ...args) {
  const { player } = await this.playerService.getPlayerData(userId);
}
```

## 四、结构化字段的双向同步

`ctx` 上有两份数据：`ctx.player.backpack`（JSON 字符串）和 `ctx.backpack`（已解析的数组）。
`mutate` 在落库前会自动判定并同步，两种写法都安全：

```ts
// 写法 A：改解析后的数组（推荐）
ctx.backpack[0].quantity -= 5;

// 写法 B：直接改字符串（也支持，不会被 A 覆盖）
ctx.player.backpack = JSON.stringify(items);
```

判定规则：**只有 `player.xxx` 字符串未被直接改写时，才以 `ctx.xxx` 为准回写**。
这样"改了 ctx 忘记写回 player"的改动不会静默丢失。

## 五、陷阱

### 跨玩家写入会死锁

```ts
// 禁止：持 A 的锁去改 B，A→B 与 B→A 并发时死锁
await this.mutate.mutate(uidA, async (ctxA) => {
  await this.mutate.mutate(uidB, (ctxB) => { ... });
});
```

正确做法：把 B 的变更移到 A 的 `mutate` 之外，或走独立的定向写入通道。

### 只读场景用 `read`

不需要修改时调 `mutate.read()`，它持锁读快照但不落库，避免无谓写入与审计噪音。

### 异常即回滚

`fn` 抛异常时不会落库，异常正常向上冒泡。可以放心在 `fn` 里做业务校验并 `throw`。

## 六、迁移存量代码

存量还有 218 处裸写，按**高危优先**渐进迁移，不需要停工重写（`mutate` 与裸写可共存）：

1. 采集「开始」/ 救援结算（后台定时器，与指令并发最频繁）——采集「开始」已迁，
   采集「结算」因属多阶段幂等事务按第八节保留
2. 战斗链路（`weaponAttack` 及其调用方）
3. 使魔技能
4. 兑换 / 召唤 / 商店（涉及货币，优先级可提前）

迁移范式：

```ts
// 迁移前
async someCommand(userId: number) {
  const { player, markers } = await this.playerService.getPlayerData(userId);
  if (!canDo(player)) return '条件不足';
  doSomething(player, markers);
  await this.playerService.savePlayer(player);
  return '成功';
}

// 迁移后
async someCommand(userId: number) {
  return this.mutate.mutate(userId, (ctx) => this.applySomeCommand(ctx));
}

private applySomeCommand(ctx: MutateContext): string {
  const { player, markers } = ctx;
  if (!canDo(player)) return '条件不足';
  doSomething(player, markers);
  return '成功';   // 不再手动保存
}
```

**迁完一处，就把 `architecture-guard.spec.ts` 里的 `RAW_SAVEPLAYER_BASELINE` 调低一处**，
让门禁变成可度量的进度条。

## 七、渐进式迁移的使能机制

迁移不能一蹴而就，因为 `mutate` 包裹的函数内部常调用 `addExp` / `taskService.advance`
这类**自己也会读档并保存**的基础方法。若直接包 `mutate`，基础方法会产生第二份快照，
把 `mutate` 的未落库改动覆盖掉（正是「自我覆盖」反例）。为此做了两件事：

### 7.1 基础方法感知 mutate 上下文

`PlayerService.addExp`、`TaskService.advance` / `completePendingTask` 在开头探测
`mutateContext.currentFor(userId)`：

- **命中**：直接改 `ctx.player`，不再自己读档、不再自己保存，改动随最外层 `mutate` 一起落库。
- **未命中**：走原有「自己读档 → 改 → 自己保存」兼容路径。

这样被 `mutate` 包住时不会产生第二份快照，而脱离 `mutate` 的存量调用（指令 handler）
行为完全不变。**这是「mutate 化可局部推进」的前提**——不必一次性改造整条调用链。

> 探测用的 `PlayerMutateContextService` 刻意零业务依赖，专门打破 `PlayerService`
> 与 `PlayerMutateService` 的循环依赖。

### 7.2 大服务用 `mutatePlayer` 薄封装收口

`GameService` 等被众多测试桩以位置参数手工构造，新增一个**必填**依赖会撑破所有桩。
因此 `GameService` 注入 `PlayerMutateService` 用 `@Optional()`，并提供一个薄封装：

```ts
private mutatePlayer<T>(userId: number, fn: (ctx: any) => Promise<T> | T): Promise<T> {
  if (this.playerMutate) return this.playerMutate.mutate(userId, fn);
  // 测试桩未注入时的等价回退路径（生产由 Nest 注入真实实现）
  return this.playerService.withUserLock(userId, async () => {
    const ctx = await this.playerService.getPlayerData(userId);
    const r = await fn(ctx);
    await this.playerService.savePlayer(ctx.player);
    return r;
  });
}
```

业务方法改成 `return this.mutatePlayer(userId, async (ctx) => { ... })`，
移除内部的 `getPlayerData` 与 `savePlayer`。**生产走真实 `mutate`**（含字段同步与货币审计），
未注入的测试桩走等价回退，行为不变。

> 注意：回退路径里的 `savePlayer` 会被架构门禁计入裸写基数，所以经由 `mutatePlayer`
> 迁移**不会降低裸写计数**——它的价值是让生产代码走 Actor 式入口、消除并发与自我覆盖，
> 而非在门禁数字上立刻体现。门禁的核心不变量是「不得新增裸写」。

## 八、例外：保留多阶段事务的 saga 路径

并非所有写入都该压成「单次读 + 单次写」。

`applySettleGatherResource`（采集结算的数据库段）是**多阶段 saga**：先原子认领「采集中」
状态（P2025 CAS），再结算产出/经验/任务，中途多处落库以支撑**幂等防重结算**。
它已经包在 `withUserLock` 内串行化，且自带的 CAS 认领逻辑**正是为了在两个并发结算入口
（定时器 + 5 秒兜底扫描）之间防止双结算**。

强行塞进 `mutate` 的单次落库模型，会把这套精心设计的幂等机制破坏掉，风险大于收益。
**此类路径保留显式多阶段保存，但必须（且已）持用户级锁**——它不在「mutate 化」清单里。

判断标准：

| 路径类型 | 是否进 mutate | 原因 |
|---|---|---|
| 单快照读改写（采集开始、技能、普通指令） | ✅ 是 | 天然适配单次落库 |
| 被 mutate 包住的基础方法（addExp/advance） | ⚠️ 感知 ctx | 复用快照，不自己落库 |
| 多阶段幂等事务（采集结算、副本清场） | ❌ 否 | 需分阶段保存做防重，已持锁串行 |

## 九、参考

- 实现：`server/src/modules/game/player-mutate.service.ts`
- 上下文登记：`server/src/modules/game/player-mutate-context.service.ts`
- 测试：`server/test/player-mutate.spec.ts`（语义）、`server/test/architecture-guard.spec.ts`（门禁）
- 已迁移示范：`familiar-skills.service.ts`（绝灭天使-光翼）、`game.service.ts`（handleGatherResource 采集开始）
