# 全服世界事件 · 设计文档

> 状态：设计稿 v1，待评审
> 日期：2026-09-17
> 背景：单机内容深度不足、玩家黏性低。核心诊断之一是**世界等级机制把正反馈做成了惩罚**——
> 玩家越肝，全服怪物越强，净体感是「原地踏步」。本设计把同一个数值翻转成**全服共同推进的进度条**，
> 用最低的改造成本引入「他人」这个内容源，为后续 PVP / 多人玩法铺路。
> 定位：**第一期 · 合作型多人玩法**（零对抗、零挫败、不依赖同时在线）。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 衡量方式 |
| --- | --- | --- |
| G1 | 把「越肝怪越强」翻转为「我们一起推线」 | 事件周期内公屏讨论量、指令调用量 |
| G2 | 让每一次击杀具备**社交意义**（不只是个人收益） | 里程碑达成时公屏播报触达率 |
| G3 | 为终局玩家提供**周期性新目标** | 周活跃留存 |
| G4 | 零侵入战斗主链路，不触碰 G9 行数冻结 | `architecture-guard.spec.ts` 全绿 |

### 1.2 非目标（本期不做）

- ❌ 个人贡献排行 / 个人贡献奖励（Phase 2，见 §11.3）
- ❌ 世界 Boss 共享血条（独立玩法，另开设计文档）
- ❌ 任何形式的玩家对抗（第二期再做）
- ❌ 全服掉落/经验倍率类 buff（需改 `combat-system.service.ts`，受 G9 冻结，见 §8.4）

---

## 2. 现状链路（代码定位）

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| ① 世界熟练度累加 | `combat-system.service.ts:2889-2890`、`:3739-3740`、`:5692-5696` | **任意一方被击杀** → `世界熟练度` +1（另有物种熟练度 +1） |
| ② 内存权威存储 | `global-proficiency.service.ts:87` `points: Map` | 内存权威 + 10s 定时脏写回 + 关闭时 flush |
| ③ 落库位置 | `SystemConfig` 键 `game.globalMarkers`（type=json） | `Record<"<名称>熟练度", number>` |
| ④ 等级换算 | `global-proficiency.service.ts:57` `proficiencyLevelFromPoints` | `floor(√点数) + 1` |
| ⑤ 怪物等级 | `map.service.ts:1354` / `global-proficiency.service.ts:258` | `物种熟练度等级 + 世界熟练度等级` |

**关键洞察**：`世界熟练度` 是一个**只增不减的全服计数器**，且其增量 ≈ 全服战斗事件总数。
这意味着**无需新增任何计数代码**，用「周期起始点数 vs 当前点数」的差值就能得到全服进度。

> ⚠️ 口径提示：`combat-system` 中有 3 处 `addProficiency(WORLD_PROFICIENCY_NAME, 1)`，
> 分别覆盖「怪物击倒目标」「怪物击杀目标」「击杀结算（抢占奖励后）」三条路径，
> 一次击杀可能触发多于 1 次累加。**差值口径不受此影响**（倍数关系恒定），
> 但**目标数值必须实测校准**，见 §5.3。

---

## 3. 设计总览

### 3.1 一句话

> 每周一个全服击杀目标，进度条实时可见，达成 25/50/75/100% 逐级解锁全服增益，
> 达成后开启奖励领取窗口，人人可领一次。未达成则世界等级照常上涨（保留原压力）。

### 3.2 三层反馈结构

```
   玩家击杀 ──→ 世界熟练度 +1 ──→ 进度条 +1（公屏可见、指令可查）
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ↓                             ↓                             ↓
   即时反馈                      中期反馈                        终局反馈
 进度条实时跳动              里程碑解锁全服增益              领取世界奖励
 （面板/公屏播报）        （活力/签到/货舱等加成）        （限领一次，防重复）
```

### 3.3 为什么这样设计

1. **零新增计数**：复用现有 `世界熟练度`，不动 `combat-system`（躲开 G9 冻结）
2. **零同时在线依赖**：异步累积，DAU=10 也能推进
3. **零挫败**：只有达成奖励，没有失败惩罚；未达成只是「没拿到额外奖励」
4. **可运营**：周期、目标、里程碑、奖励表全部 `SystemConfig` 在线可调，改完立即生效

---

## 4. 数据模型

### 4.1 新增表（Prisma）

```prisma
// ========== 全服世界事件 ==========

/// 世界事件周期：一个周期 = 一次全服共同目标。
/// 进度不单独计数，取自「世界熟练度」点数差值（见 global-proficiency.service.ts）。
model WorldEventCycle {
  id           Int       @id @default(autoincrement())
  /// 周期标识，自然周格式化：2026-W38；人工开启时可带后缀（如 2026-W38-1）
  cycleId      String    @unique
  /// 进度指标：kill=击杀（本期唯一）；预留 gather / craft / challenge
  metric       String    @default("kill")
  /// 周期开始时「世界熟练度」点数快照（差值计数的基准）
  startPoints  Float     @default(0)
  /// 本周期目标增量（管理员可按上周实际值校准）
  goalPoints   Float     @default(0)
  startAt      DateTime
  endAt        DateTime
  /// ACTIVE=进行中；SETTLED=已结算（奖励领取窗口仍开放至 graceEndAt）
  status       String    @default("ACTIVE")
  /// 已解锁的里程碑：{ "25": "2026-09-18T10:00:00.000Z", "50": ... }（键=百分比，值=达成时刻）
  reached      Json?
  /// 结算时点数快照（用于复盘与下周期目标校准）
  finalPoints  Float?
  /// 领取窗口截止（结算后仍可领 N 小时，默认 24h；过期未领视为放弃）
  graceEndAt   DateTime?
  settledAt    DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  claims       WorldEventClaim[]

  @@index([status, endAt])
}

/// 世界事件奖励领取记录：同一玩家同一周期同一档位只能领一次（幂等）
model WorldEventClaim {
  id        Int      @id @default(autoincrement())
  cycleId   Int
  cycle     WorldEventCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  userId    Int
  /// 领取的里程碑档位：25 / 50 / 75 / 100
  percent   Int
  createdAt DateTime @default(now())

  @@unique([cycleId, userId, percent])
  @@index([userId, createdAt])
}
```

**设计取舍说明**：

- **为什么只有 2 张表**：里程碑没有独立状态（只有「是否达成 + 达成时刻」），
  存进 `WorldEventCycle.reached` 的 JSON 足够，不值得单独建表；
  领取记录必须独立建表（唯一约束做幂等，与 `RedPacketClaim` 同构）。
- **为什么不存进度数值**：进度 = `当前世界熟练度 - startPoints`，是**派生值**。
  存一份会与真相源打架（世界熟练度是内存权威 + 10s flush，无法反向同步）。

### 4.2 复用表（不新增）

| 用途 | 复用 | 说明 |
| --- | --- | --- |
| 进度数据源 | `SystemConfig.game.globalMarkers` | 读 `世界熟练度` 点数，经 `GlobalProficiencyService.getPoints('世界')` |
| 规则/奖励/开关 | `SystemConfig` 表 | 全部走 `worldEvent.*` 配置键，见 §5 |
| 广播留档 | `ChatMessage`（`type='system'`） | 经 `chatService.broadcastSystem('世界频道', ...)`，自动落库 |
| 定时结算 | `DelayedTask` 表 | 可选，用于「周期结束 N 小时后关闭领取窗口」的跨重启延时 |
| 指令埋点 | `CommandLog` | `command.service.ts:642` 自动记录，无需额外代码 |

### 4.3 玩家侧状态

**不新增 `Player` 字段**。领取资格完全由 `WorldEventClaim` 表判定
（`@@unique([cycleId, userId, percent])`）。
这与项目「跨天状态放 `Player.markers`」的惯例不同，原因：领取记录需要**跨周期保留 + 可审计**，
放 markers 会随玩家存档整包读写放大；独立表 + 唯一约束是 `RedPacketClaim` 已验证的做法。

---

## 5. 配置项清单

> 全部加在 `server/src/modules/system-config/system-config.service.ts` 的 `DEFAULT_CONFIGS`（L121-306 之间）。
> 按项目铁律：**任何可能变化的阈值/开关/周期/奖励都必须可在线调整，不得硬编码**。
> `onModuleInit` 的 `ensureDefaultConfigs()`（L323-386）会自动补行且不覆盖管理员改动，**无需重跑 seed**。

### 5.1 开关与周期

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.enabled` | boolean | `true` | 总开关。关闭后不再自动开新周期，已激活周期照常结算 |
| `worldEvent.cycleDays` | number | `7` | 周期天数（自然周对齐；7=每周一 00:00 切周期） |
| `worldEvent.autoStart` | boolean | `true` | 是否由 cron 自动开启新周期；false 时只能管理员指令开 |
| `worldEvent.graceHours` | number | `24` | 结算后奖励领取窗口时长（小时） |

### 5.2 目标与里程碑

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.metric` | string | `kill` | 进度指标（本期仅 `kill`） |
| `worldEvent.baseGoal` | number | `20000` | 目标增量基准（**必须按实测校准**，见 §5.3） |
| `worldEvent.goalAutoAdjust` | boolean | `true` | 按上周期实际完成度自动缩放下周期目标 |
| `worldEvent.goalAdjustMin` | number | `0.6` | 自动缩放下限系数（上周期完成 40% → 下周期目标 ×0.6 兜底） |
| `worldEvent.goalAdjustMax` | number | `1.5` | 自动缩放上限系数（上周期超额 200% → 至多 ×1.5，防通胀） |
| `worldEvent.milestones` | json | `[25,50,75,100]` | 里程碑百分比档位数组 |
| `worldEvent.startPointsFallback` | number | `0` | 取不到世界熟练度时的起始点数兜底（不应发生，仅防炸） |

### 5.3 目标数值校准（重要）

`世界熟练度` 每次击杀的累加次数取决于 `combat-system` 的 3 个调用点是否都被触发，
理论区间为 **1~3 次/击杀**。因此 `baseGoal` 不能拍脑袋定：

1. 上线前先**只读观测一个周期**（`worldEvent.enabled=true` 但 `rewards` 留空），
   记录 `WorldEventCycle.finalPoints - startPoints` 的实际值 `A`；
2. 按期望完成度设定 `baseGoal`：想让玩家「努力一下才达成」，取 `A × 1.1 ~ 1.3`；
3. 之后交给 `goalAutoAdjust` 自动浮动。

> 建议先做**一个周期的暗桩观测**再正式开启奖励，避免目标定得离谱（要么秒达，要么永远达不成）。

### 5.4 奖励表

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.rewards` | json | 见下 | 里程碑奖励表（**直接复用签到奖励的条目结构**） |
| `worldEvent.buffs` | json | 见下 | 里程碑达成的全服增益表 |

**`worldEvent.rewards` 结构**（与 `checkin-config.defaults.ts` 的 `CheckinRewardGroup` 同构，便于复用解析器）：

```json
{
  "milestones": [
    { "percent": 25, "rewards": [{ "type": "item", "name": "强化券", "count": 5 }] },
    {
      "percent": 50,
      "rewards": [
        { "type": "item", "name": "强化券", "count": 10 },
        { "type": "exp", "name": "", "count": 5000 }
      ]
    },
    {
      "percent": 75,
      "rewards": [
        { "type": "item", "name": "史诗强化券", "count": 5 },
        { "type": "vitality", "name": "", "count": 20 }
      ]
    },
    {
      "percent": 100,
      "rewards": [
        { "type": "item", "name": "传说强化券", "count": 5 },
        { "type": "item", "name": "觉醒丹", "count": 1 },
        { "type": "vitality", "name": "", "count": 50 }
      ]
    }
  ]
}
```

**`worldEvent.buffs` 结构**（全服增益，达成即生效，持续到本周期结束）：

```json
{
  "buffs": [
    { "percent": 25, "type": "cargoPods", "value": 1, "label": "每小时额外货舱 +1" },
    { "percent": 50, "type": "checkinExp", "value": 20, "label": "每日签到经验 +20%" },
    { "percent": 75, "type": "vitalityRegen", "value": 25, "label": "活力恢复速度 +25%" },
    { "percent": 100, "type": "challengeBox", "value": 1, "label": "挑战层每日奖励箱 +1" }
  ]
}
```

**为什么 buff 只选这四类**：它们全部落在**非 G9 冻结文件**里（见 §8.4），
本期不需要动 `combat-system.service.ts` 一个字。

| buff type | 生效位置（文件 : 行） | 受 G9 冻结 |
| --- | --- | --- |
| `cargoPods` 额外货舱 | `schedule.service.ts:804` `dropCargoPods` | ❌ 否 |
| `checkinExp` 签到经验 | `checkin-reward.service.ts:78` `calcExp` | ❌ 否 |
| `vitalityRegen` 活力恢复 | `time-settle.service.ts:61-73` | ❌ 否 |
| `challengeBox` 挑战层奖励箱 | `time-settle.service.ts:378-388` | ❌ 否 |
| ~~`dropRate` 全服掉率~~ | ~~`combat-system` 掉落链路~~ | ✅ **是，本期不做** |

### 5.5 展示与播报

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.announceOnMilestone` | boolean | `true` | 里程碑达成是否公屏播报 |
| `worldEvent.announceOnStart` | boolean | `true` | 新周期开启是否公屏播报 |
| `worldEvent.progressBroadcastStep` | number | `10` | 进度每跨过 N% 播报一次（0=关闭） |
| `worldEvent.panelTitle` | string | `星海远征` | 面板/活动名（可每期换，制造新鲜感） |
| `worldEvent.panelDesc` | string | 见 §6.4 | 面板副标题 / 背景故事 |

---

## 6. 指令设计

### 6.1 指令表（`server/prisma/seed.ts`）

```ts
{ name: '世界事件', alias: 'world-event,事件,sj', description: '查看全服世界事件进度与奖励', handlerKey: 'worldEvent', minRole: 'USER', sortOrder: 360 },
{ name: '领取世界奖励', alias: 'claim-world-reward,lqsjjl', description: '领取已解锁的世界事件奖励', handlerKey: 'worldEvent', minRole: 'USER', sortOrder: 361 },
{ name: '世界事件管理', alias: 'world-event-admin', description: '开启/结算/重置世界事件(管理员)', handlerKey: 'worldEvent', minRole: 'ADMIN', sortOrder: 999 },
```

**命名注意事项**（踩过的坑，见 `seed.ts:80` 注释）：

- `command.service.ts:300-326` 有**前缀匹配兜底**，新指令名不能是已有指令名/别名的前缀，
  也不能被已有指令名前缀匹配吞掉。`世界事件` 与 `世界事件管理` 互为前缀，
  **需实测确认分发优先级**（引擎按 name 精确匹配优先，理论上安全，但必须在测试里覆盖）。
- 备选方案：并入现有 `管理` 指令（`admin-command.service.ts:96`）做子命令，彻底规避冲突。

### 6.2 落地方式：独立 handlerKey 子域（**不写进 `game-command.handler.ts`**）

> 架构门禁硬要求（`architecture-guard.spec.ts`）：
> - **G5**：`game-command.handler.ts` 行数 ≤ 2041
> - **G1**：`game.service.ts` 行数 ≤ 1778
> - **G6**：`game.service.ts` 的 `handleXxx(` 方法数 ≤ 241
> - G5 报错原文：「新增指令一律新文件，不得继续写入 GameCommandHandler.dispatch 的分支」

因此必须新建子域：

| 文件 | 作用 |
| --- | --- |
| `server/src/modules/command/handlers/world-event.handler.ts` | 新建，实现 `CommandHandler` 接口，含 3 个指令分支 |
| `server/src/modules/command/handlers/index.ts:26-44` | 把 `WorldEventHandler` 加进 `handlerProviders` 数组 |
| `server/src/modules/game/world-event.service.ts` | 新建，业务逻辑（周期管理 / 进度 / 发奖 / cron） |
| `server/src/modules/game/world-event-config.defaults.ts` | 新建，纯常量模块（配置键 + 默认值），分层理由照抄 `checkin-config.defaults.ts`（避免 `system-config → game → system-config` 循环依赖） |
| `server/src/modules/game/game.module.ts` | providers / exports 注册 `WorldEventService` |

**方法签名约定**（与全项目一致，返回回执文案字符串）：

```ts
// world-event.service.ts
async viewPanel(userId: number): Promise<string>                    // 进度面板回执
async claimReward(userId: number, percent?: number): Promise<string> // 领取奖励
async adminCommand(userId: number, args: string[]): Promise<string>  // 管理指令（内部自鉴权）
```

> ⚠️ `minRole` 目前**不被引擎强制执行**（`command.service.ts:359-362` 是空实现）。
> 管理员指令必须**自己在 service 里查 `user.role`** 鉴权，照抄 `admin-command.service.ts:96`：
> ```ts
> const user = await this.prisma.user.findUnique({ where: { id: userId } });
> if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') return '权限不足，需要管理员权限';
> ```

### 6.3 管理员子命令

```
世界事件管理 开启 [目标值]     手动开启新周期（目标值可选，缺省按 baseGoal + 自动缩放）
世界事件管理 结算              立即结算当前周期（调试/活动收尾）
世界事件管理 重置              丢弃当前周期（不计入历史）
世界事件管理 目标 20000        调整当前周期目标
```

### 6.4 回执文案

**`世界事件`（进度面板）**

```
🌍 世界事件 · 星海远征
━━━━━━━━━━━━━━━━━━━━
异界的裂隙正在扩大，全使魔的战斗意志是世界唯一的屏障。

⏳ 周期：2026-W38（剩余 3 天 14 小时）
📊 进度：14,286 / 20,000（71.4%）
[██████████████░░░░░░] 71%

🏆 里程碑
  ✅ 25%  已达成 · 每小时额外货舱 +1
  ✅ 50%  已达成 · 每日签到经验 +20%
  ⏳ 75%  未达成 · 活力恢复速度 +25%（还差 714）
  ⏳ 100% 未达成 · 挑战层每日奖励箱 +1（还差 5,714）

🎁 可领取：2 项　→ 发送「领取世界奖励」
```

**`领取世界奖励`**

```
✅ 领取成功！
  · 强化券 x5
  · 强化券 x10
  · 经验 +5000
（第 2026-W38 周期 · 25% / 50% 里程碑）
```

**失败分支文案**（注意避开 `isSuccessfulAction` 的失败关键词黑名单，
`game-command.handler.ts:71/77` 命中「失败/错误/无法/未找到/冷却中」等会**阻止任务推进**）

| 场景 | 文案 |
| --- | --- |
| 无进行中周期 | `当前没有进行中的世界事件，下一周期即将开启` |
| 无可领奖励 | `暂时没有可领取的世界奖励，先把进度推上去吧` |
| 已领过 | `这项奖励你已经领过了（第 2026-W38 周期）` |
| 领取窗口已关闭 | `第 2026-W37 周期的奖励领取已关闭` |
| 权限不足 | `权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）` |

**里程碑达成播报**（公屏，走 `broadcastSystem`）

```
🌍 全服里程碑！世界进度突破 50%
「每日签到经验 +20%」已对全服生效，持续至本周期结束。
距下一档 75% 还差 5,000，继续推进！
```

**新周期开启播报**

```
🌍 新的世界事件开启：星海远征（第 2026-W38 周期）
目标：全服击杀累计 20,000　周期：7 天
达成里程碑即可解锁全服增益，100% 达成更有全员奖励。
发送「世界事件」查看进度。
```

---

## 7. 进度计算与周期流转

### 7.1 进度读取（零侵入核心）

```ts
// world-event.service.ts
async currentProgress(cycle: WorldEventCycle): Promise<{
  current: number; goal: number; percent: number;
}> {
  // 唯一真相源：世界熟练度点数（内存权威 + 10s flush）
  const now = await this.globalProficiency.getPoints(WORLD_PROFICIENCY_NAME);
  const start = Number(cycle.startPoints) || 0;

  // 管理员用 replacePoints 整表替换过 → 差值变负，需自愈
  if (now < start) {
    this.logger.warn(`世界熟练度出现回退（${start} → ${now}），重置周期基准`);
    await this.resetCycleBaseline(cycle.id, now);
    return { current: 0, goal: Number(cycle.goalPoints), percent: 0 };
  }

  const current = now - start;
  const goal = Number(cycle.goalPoints) || 1;
  return { current, goal, percent: Math.min(100, Math.floor((current / goal) * 100)) };
}
```

> `GlobalProficiencyService.getPoints(name)` 是 public 方法（`global-proficiency.service.ts:218`），
> 返回**原始点数**（不是等级），正是差值计算所需。**无需改动该服务一行代码。**

### 7.2 周期流转状态机

```
  [无周期] ──cron/指令──→ ACTIVE ──到 endAt──→ SETTLED ──graceEndAt──→ [归档]
                            │                    │
                            │ 里程碑达成          │ 玩家仍可领奖
                            ↓                    ↓
                      写 reached + 播报      WorldEventClaim 判定幂等
```

**cron 任务**（新建于 `world-event.service.ts`，注册进 `game-tasks.module.ts`）：

```ts
@Cron('0 */10 * * * *')              // 每 10 分钟
async worldEventTick() {
  if (this.worldEventRunning) return;           // 运行锁，防重入
  this.worldEventRunning = true;
  try {
    await this.ensureActiveCycle();             // 无周期且 autoStart → 开新周期
    await this.checkMilestones();               // 检查并解锁里程碑（含播报）
    await this.settleIfDue();                   // 到点结算
  } catch (err: any) {
    this.logger.error(`世界事件轮询失败: ${err?.message ?? err}`);  // 只告警，绝不抛出
  } finally {
    this.worldEventRunning = false;
  }
}
```

> 照抄 `schedule.service.ts:970` 的运行锁范式；cron 抛错会打满日志。

**结算幂等**（照抄 `red-packet.service.ts:569-573` 的条件更新抢占）：

```ts
// 多实例/重入只结算一次
const acquired = await this.prisma.worldEventCycle.updateMany({
  where: { id: cycle.id, status: 'ACTIVE' },
  data: { status: 'SETTLED', settledAt: new Date(), finalPoints: now },
});
if (acquired.count === 0) return;   // 已被别人结算，直接返回
```

### 7.3 目标自动缩放

结算时按完成度算下周期目标（`goalAutoAdjust=true` 时）：

```ts
const ratio = actual / goal;                                  // 上周期完成度
const factor = Math.min(goalAdjustMax, Math.max(goalAdjustMin, ratio));
const nextGoal = Math.max(1, Math.floor(goal * factor));
```

例：目标 20000 实完 34000（170%）→ factor=1.5 → 下周期 30000。

---

## 8. 奖励发放

### 8.1 发放出口

**直接复用 `CheckinRewardService.grantRewards`**（`checkin-reward.service.ts:125`），
它已支持 `item` / `exp` / `vitality` 三种类型并有完善的容错。

```ts
const texts = await this.checkinReward.grantRewards(userId, entries, { player });
```

> 奖励条目结构与签到完全一致（`{ type, name, count }`），
> 解析/规范化逻辑照抄 `normalizeRewards` / `normalizeGroups` 的写法即可。

**货币类奖励**：若后续需要发钻石/数据核心，走统一入口
`setCurrencyAmount(player, '钻石', value, backpack)`（`player.service.ts:858`），
`CurrencyLog` 审计由 `savePlayer` / `mutate` 管道**自动生成**，无需手写。

### 8.2 幂等与离线到账

```ts
// 1) 唯一约束做幂等（与 RedPacketClaim 同构）
try {
  await this.prisma.worldEventClaim.create({
    data: { cycleId: cycle.id, userId, percent },
  });
} catch {
  return '这项奖励你已经领过了';    // 违反 @@unique → 已领过
}

// 2) 先记账后发货；发货失败要回滚记录，避免"领了但没到账"
try {
  await this.checkinReward.grantRewards(userId, entries, { player });
} catch (err) {
  await this.prisma.worldEventClaim.delete({ where: { id: claim.id } });
  throw err;
}
```

**离线玩家**：奖励走 `addToBackpack` 直接写库，**不要求在线**（照抄红包退款 `red-packet.service.ts:557`）。
在线通知（`emitToUser`）只是附加，不是发奖路径的一部分。

### 8.3 批量发奖（若未来做「达成即全员直发」）

不要照抄 `handleWealthRanking` 的无分页全表扫描（`ranking-command.service.ts:261`）。
正确范式（`red-packet.sweepExpired`）：

- `findMany` + `take: BATCH_SIZE` 分批
- 单人发奖包进 `playerService.addToBackpack`（内部 `enqueueUserWrite` 串行）
- 单人 `try/catch` 兜底，失败不中断整批

### 8.4 为什么本期不做「全服掉率 buff」

`combat-system.service.ts` 被 G9 **行数冻结在 12468 行**（`architecture-guard.spec.ts:577-596`），
且统计口径是 `wc -l`，**注释也算行**。掉率 buff 需要在掉落链路注入倍率，必然加行。

若确需此 buff，两条路：
1. 把倍率计算抽到**新的 util 文件**（`world-event-buff.util.ts`），`combat-system` 只加 1~2 行调用 → 仍需上调 G9 基线 + PR 评审；
2. 改挂在**不受冻结的调用方**（如 `delayed-settle.service.ts` 结算出口）→ 优先选这条。

---

## 9. 广播与前端呈现

### 9.1 后端广播

| 场景 | 方式 | 是否落库 |
| --- | --- | --- |
| 周期开启 / 里程碑达成 | `chatService.broadcastSystem('世界频道', text)`（`chat.service.ts:57`） | ✅ 落 `ChatMessage(type='system')` |
| 进度条实时刷新 | `chatService.emitToChannel('世界频道', 'worldEvent:progress', {...})`（`:111`） | ❌ 不落库 |
| 个人领取成功 | `chatService.emitToUser(userId, 'worldEvent:claimed', {...})`（`:100`） | ❌ 不落库 |

> 广播落库的价值：历史消息可刷新回放，天然成为**事件留痕**，省一张埋点表。

### 9.2 只读 API（写操作一律走指令，不新增写接口）

> 项目约定：写操作零新增接口，一律发与 QQ 端逐字相同的指令，保证单写路径、结算不双轨。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/game/world-event/current` | 当前周期 + 进度 + 里程碑 + 本人可领状态 |

返回体草案：

```json
{
  "cycleId": "2026-W38",
  "title": "星海远征",
  "description": "异界的裂隙正在扩大……",
  "startAt": "2026-09-14T00:00:00.000Z",
  "endAt": "2026-09-21T00:00:00.000Z",
  "current": 14286,
  "goal": 20000,
  "percent": 71,
  "milestones": [
    { "percent": 25, "reached": true, "buffLabel": "每小时额外货舱 +1" },
    { "percent": 50, "reached": true, "buffLabel": "每日签到经验 +20%" },
    { "percent": 75, "reached": false, "buffLabel": "活力恢复速度 +25%" },
    { "percent": 100, "reached": false, "buffLabel": "挑战层每日奖励箱 +1" }
  ],
  "claimable": [25, 50],
  "status": "ACTIVE"
}
```

**OpenAPI**：新增端点必须同步更新 `docs/openapi.json`（项目规范要求可导入 Apifox）。
建议在 `world-event.controller.ts` 上加 `@ApiOperation` / `@ApiResponse` 装饰器后重新导出。

### 9.3 前端

| 位置 | 形态 | 说明 |
| --- | --- | --- |
| `ChatView.vue` 顶部 | 常驻细进度条 | 调 `/api/game/world-event/current`，监听 `worldEvent:progress` 实时更新 |
| 独立面板 / 指令回执 | 完整面板 | 点击进度条展开，或由 `世界事件` 指令回执渲染 |
| 里程碑达成 | 复用 `game:highlight` 动画 | `highlight.service.ts:63` 已支持定向高光事件 |

> 前端图标/文案/颜色建议放进 `web/src/config.js`（项目已有 `HOME_YARD_CONFIG` 的先例），避免硬编码。
> Q群端只有纯文本回执，面板文案必须不依赖颜色/进度条字符也能读清。

---

## 10. 埋点设计

### 10.1 现有埋点（自动获得，无需开发）

| 埋点 | 位置 | 覆盖内容 |
| --- | --- | --- |
| `CommandLog` | `command.service.ts:642-663` | 每条 `世界事件` / `领取世界奖励` 调用：指令名、回执、耗时、来源（web/bot） |
| `ChatMessage(type='system')` | `chat.service.ts:57` | 周期开启、里程碑达成的**全量留痕**（含时间戳） |
| `CurrencyLog` | `player.service.ts:1509` | 若发货币，变动自动审计 |

### 10.2 本期新增埋点

**① 周期归档（结构化，落 `WorldEventCycle` 表）**

结算时写入 `finalPoints`、`reached`（各档达成时刻）、`settledAt`。
本身就是周期维度的完整埋点，支持复盘「第 N 周期完成度 = X%」。

**② 参与率（新增配置项，结算时追加）**

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.history` | json | `[]` | 每周期归档一条，最多保留 20 条 |

```json
[
  {
    "cycleId": "2026-W38",
    "goal": 20000,
    "actual": 34120,
    "percent": 100,
    "reachedMilestones": [25, 50, 75, 100],
    "claimedUsers": 87,
    "activeUsers": 120,
    "settledAt": "2026-09-21T00:00:05.000Z"
  }
]
```

> `activeUsers` 口径：取**事件周期内有过 CommandLog 的去重 userId**
> （`prisma.commandLog.findMany({ where: { createdAt: { gte, lt } }, distinct: ['senderId'] })`），
> 比 `updatedAt` 近 5 分钟估算准确（后者会被后台自动保存误判，见 `admin.service.ts:876-877`）。

**③ 关键指标（运营看板）**

| 指标 | 计算方式 | 用途 |
| --- | --- | --- |
| 周期完成度 | `actual / goal` | 校准 `baseGoal` |
| 参与率 | `claimedUsers / activeUsers` | 判断玩法是否被感知 |
| 里程碑达成分布 | `reachedMilestones` 长度分布 | 判断难度曲线是否合理 |
| 面板查看频次 | `CommandLog where command='世界事件'` 计数 | 判断玩家是否关注进度 |

### 10.3 不建议做的埋点

- ❌ 新增独立 `Analytics` / `EventLog` 表：项目无此先例，`ChatMessage` + `CommandLog` + 周期表已足够；
- ❌ 在 `combat-system` 埋点：会撞 G9 行数冻结。

---

## 11. 改动清单与分期

### 11.1 文件级改动清单

| # | 文件 | 改动 | 门禁风险 |
| --- | --- | --- | --- |
| 1 | `server/prisma/schema.prisma` | 新增 `WorldEventCycle` / `WorldEventClaim` 两个 model | 无 |
| 2 | `server/src/modules/game/world-event-config.defaults.ts` | **新建**：配置键常量 + 默认值（照抄 `checkin-config.defaults.ts`） | 无 |
| 3 | `server/src/modules/system-config/system-config.service.ts` | `DEFAULT_CONFIGS` 追加 `worldEvent.*` 全部配置键（L306 之前） | 无 |
| 4 | `server/src/modules/game/world-event.service.ts` | **新建**：周期管理 / 进度读取 / 里程碑 / 结算 / 发奖 / cron | 无（新文件不受冻结） |
| 5 | `server/src/modules/command/handlers/world-event.handler.ts` | **新建**：`handlerKey='worldEvent'` 子域，3 个指令分支 | 无 |
| 6 | `server/src/modules/command/handlers/index.ts` | `handlerProviders` 注册 `WorldEventHandler`（L26-44） | 无 |
| 7 | `server/src/modules/game/game.module.ts` | providers/exports 注册 `WorldEventService` | 无 |
| 8 | `server/src/modules/game/game-tasks.module.ts` | 确保 `WorldEventService` 在调度模块可见（cron 生效） | 无 |
| 9 | `server/prisma/seed.ts` | 追加 3 条指令（L51-351 区间） | 无 |
| 10 | `server/src/modules/game/schedule.service.ts` | `cargoPods` buff 挂钩（`:804`） | ⚠️ 无行数冻结，改动前跑门禁确认 |
| 11 | `server/src/modules/game/checkin-reward.service.ts` | `calcExp` 支持 `checkinExp` 全服加成系数（`:78`） | 无 |
| 12 | `server/src/modules/game/commands/time-settle.service.ts` | 活力恢复 / 挑战层奖励箱读取全服 buff | 无 |
| 13 | `docs/openapi.json` + 新 controller | 新增 `GET /api/game/world-event/current` 文档 | 无 |
| 14 | `server/test/world-event.spec.ts` | **新建**：见 §11.4 | 无 |
| 15 | `web/src`（`ChatView.vue` / `config.js` / `api/index.js`） | 进度条组件 + 接口封装 + 文案配置 | 无 |

### 11.2 Phase 1（本期，建议 1.5~2 周）

- 数据模型 + 配置骨架 + 周期流转（开 / 结算 / 归档）
- 进度读取（世界熟练度差值）+ 里程碑解锁 + 播报
- `世界事件` 面板指令 + `领取世界奖励` + 幂等领取
- **先跑一个只观测不发奖的周期**校准 `baseGoal`
- buff 只上 `cargoPods` + `checkinExp`（最安全、最好实现）
- 前端顶部进度条

### 11.3 Phase 2（数据验证后）

- 个人贡献榜：`WorldEventContribution` 表（草案见下），挂钩指令流水线
  ```prisma
  model WorldEventContribution {
    id        Int      @id @default(autoincrement())
    cycleId   Int
    userId    Int
    amount    Float    @default(0)
    updatedAt DateTime @updatedAt

    @@unique([cycleId, userId])
    @@index([cycleId, amount])
  }
  ```
  挂钩点建议：`command.service.ts:114-116`（`recordRankingStats` 附近，**该文件无行数冻结**），
  **不要**挂到 `combat-system`（G9）。
- 多指标扩展：`gather` / `craft` / `challenge`（需在采集 / 制造 / 挑战链路加计数）
- 剩余两类 buff（`vitalityRegen` / `challengeBox`）
- 贡献排名奖励（Top N 额外奖励）

### 11.4 必须覆盖的测试

| 场景 | 断言 |
| --- | --- |
| 进度计算 | 差值正确；`now < start` 时自愈不崩 |
| 里程碑解锁 | 跨过阈值只解锁一次；`reached` 记录达成时刻 |
| 结算幂等 | 并发两次结算只生效一次（`updateMany` count=0 分支） |
| 领取幂等 | 同一玩家同档位重复领取被拒（唯一约束） |
| 领取窗口 | `graceEndAt` 之后不可领 |
| 离线到账 | 不在线玩家背包正确增加 |
| 发货失败回滚 | `grantRewards` 抛错时 `WorldEventClaim` 记录被删除 |
| 管理员鉴权 | 非 ADMIN 调用 `世界事件管理` 被拒 |
| 指令分发 | `世界事件` 与 `世界事件管理` 不被前缀匹配互相吞掉 |
| 配置容错 | `rewards` / `buffs` 被改成非法 JSON 时回落默认且不影响其他功能 |

**回归门禁**：跑全量 `npm test`，重点确认
`architecture-guard.spec.ts`（G1/G5/G6/G9 冻结）与
`title-achievement-sources.spec.ts`（若新增成就需双写 markers + tasks）全绿。

---

## 12. 边界与注意

| 项 | 说明 |
| --- | --- |
| **世界熟练度是内存权威** | 10s flush，进程强杀最多丢 10s 增量。对周级周期可忽略；`onModuleDestroy` 会 flush |
| **管理员 `replacePoints` 会打乱差值** | 已做自愈（重置基准 + 告警），但应在使用说明里提示慎用 |
| **进度只增不减** | 与「世界等级」同构，玩家不会有「进度被打回去」的挫败感 |
| **未达成没有惩罚** | 世界等级照常上涨（原有机制不变），只是拿不到额外奖励 |
| **多实例部署** | 结算用 `updateMany` 条件更新抢占；cron 运行锁仅单实例内有效，跨实例靠数据库状态机 |
| **Q群与网页同源** | 指令走统一引擎，QQ 端回执是纯文本，面板要能在无 UI 的聊天窗里读清楚 |
| **指令名前缀冲突** | `世界事件` / `世界事件管理` 必须在测试中覆盖分发优先级（§6.1） |
| **成就双写** | 若后续加「参与世界事件」类成就，必须同时写 `markers` 与 `taskService.advance`，否则 `title-achievement-sources.spec.ts` 会红 |
| **不要往 `game.service.ts` 加 `handleXxx`** | G1 + G6 双重拦截，新指令一律走独立 handlerKey 子域 |
| **注释也算行数** | G9 统计口径是 `wc -l`；本期全程新建文件，不触碰冻结文件 |

---

## 13. 与后续多人玩法的衔接

本设计是「第一期 · 合作型多人」的地基，后续可直接复用：

| 后续玩法 | 复用本设计的什么 |
| --- | --- |
| 世界 Boss 共享血条 | 周期状态机、结算幂等、广播播报、领取记录结构 |
| 异步镜像天梯 PVP | 周期即赛季；`WorldEventCycle` 可直接承载赛季概念 |
| 悬赏 / 委托板 | 配置驱动的奖励表结构、`grantRewards` 发放出口 |
| 领地争夺 | 里程碑达成播报、全服 buff 生效框架 |

**验证顺序建议**：本玩法跑通一个完整周期后，用「参与率」和「周期完成度」两个指标判断
玩家是否买账——若参与率 > 40%，说明「全服共同目标」这条路走通，可以往对抗型玩法推进；
若 < 15%，说明玩家对多人内容无感，应先回到单机深度（Build 分化、不可逆选择）而非继续加多人玩法。
